"""Real in-memory OpenTelemetry spans; no Azure ingestion or astronomy archive traffic."""

import concurrent.futures as cf
import os
import subprocess
import sys
import urllib.error
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.responses import StreamingResponse
from fastapi.testclient import TestClient
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from opentelemetry.trace import SpanKind, StatusCode

from app import telemetry
from app.irsa import fetch
from app.models import ViewRequest
from app.processing import gaia, views


@pytest.fixture
def spans(monkeypatch):
    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    monkeypatch.setattr(telemetry, "_tracer", provider.get_tracer("test"))
    yield exporter
    provider.shutdown()


def test_cache_decisions_distinguish_pending_ready_and_disk(monkeypatch, tmp_path, spans):
    app = FastAPI(telemetry=telemetry.FASTAPI_TELEMETRY)
    app.add_middleware(telemetry.RequestTelemetry)
    monkeypatch.setattr(views, "JOBS", {})
    monkeypatch.setattr(views, "get_cache", lambda: SimpleNamespace(lookup=lambda _: None, manifest_url=str))
    monkeypatch.setattr(views.POOL, "submit", lambda *a: None)

    @app.post("/api/views")
    def create(req: ViewRequest):
        return {"status": views.create(req).status}

    req = {"ra": 10, "dec": 10, "fov_arcmin": 6, "band": "B1"}
    client = TestClient(app)
    assert client.post("/api/views", json=req).status_code == 200  # a new request is still a miss
    client.post("/api/views", json=req)  # inflight reuse is not a completed cache hit
    job = next(iter(views.JOBS.values()))
    job.status = "ready"
    client.post("/api/views", json=req)
    job.status = "error"
    client.post("/api/views", json=req)  # a failed job must retry as a miss
    monkeypatch.setattr(views.config, "CACHE_DIR", tmp_path)
    folder = tmp_path / "r" / "existing"
    folder.mkdir(parents=True)
    (folder / "manifest.json").write_text("{}")
    monkeypatch.setattr(
        views, "get_cache", lambda: SimpleNamespace(lookup=lambda _: {"render_key": "existing"}, manifest_url=str)
    )
    client.post("/api/views", json={**req, "ra": 11})
    recorded = spans.get_finished_spans()
    assert [s.attributes["cache.hit"] for s in recorded] == [False, False, True, False, True]
    assert [s.attributes["cache.layer"] for s in recorded] == ["miss", "pending", "memory", "miss", "local"]
    assert all(s.kind == SpanKind.SERVER and s.name == "POST /api/views" for s in recorded)


def test_requests_exclude_payloads_ids_and_exception_text(spans):
    app = FastAPI(telemetry=telemetry.FASTAPI_TELEMETRY)
    app.add_middleware(telemetry.RequestTelemetry)
    secret = "secret-marker-never-exported"

    @app.get("/api/items/{item_id}")
    def read(item_id: str):
        return {"ok": True}

    @app.get("/api/boom")
    def boom():
        raise RuntimeError(secret)

    @app.get("/api/stream")
    def stream():
        async def body():
            yield b"started"
            raise RuntimeError(secret)

        return StreamingResponse(body())

    client = TestClient(app, raise_server_exceptions=False)
    assert client.get(f"/api/items/{secret}?sig={secret}", headers={"Authorization": secret}).status_code == 200
    assert client.get(f"/api/{secret}/unknown").status_code == 404
    assert client.get("/api/boom").status_code == 500
    assert client.get("/api/stream").status_code == 200
    client.get("/api/health")
    client.get("/golden/barnard/manifest.json")
    recorded = spans.get_finished_spans()
    assert len(recorded) == 4
    assert [s.name for s in recorded] == [
        "GET /api/items/{item_id}",
        "GET /api/{unmatched}",
        "GET /api/boom",
        "GET /api/stream",
    ]
    assert all(secret not in repr(s.attributes) and not s.events and not s.status.description for s in recorded)
    assert recorded[-1].attributes["error.type"] == "RuntimeError"
    assert recorded[-1].status.status_code == StatusCode.ERROR


def test_archive_failures_are_dependencies_even_when_callers_catch_them(monkeypatch, spans):
    def down(*args, **kwargs):
        raise urllib.error.URLError("secret-url?sig=private")

    monkeypatch.setattr(fetch.urllib.request, "urlopen", down)
    monkeypatch.setattr(fetch.time, "sleep", lambda _: None)
    monkeypatch.setattr(fetch.fits, "open", down)
    monkeypatch.setattr(gaia, "_fetch", down)
    frame = {"url": "https://example.invalid/ibe/data/spherex/test.fits"}
    assert fetch.fetch_irsa(frame, 1, 2, 0.1) is None
    assert fetch.fetch_s3(frame, 1, 2, 0.1) is None
    with pytest.raises(gaia.GaiaUnavailable):
        gaia.query_gaia_cone(1, 2, 0.1, timeout_s=1)
    recorded = spans.get_finished_spans()
    assert {s.attributes["dependency.service"] for s in recorded} == {"IRSA", "S3", "Gaia"}
    assert all(s.kind == SpanKind.CLIENT and s.status.status_code == StatusCode.ERROR for s in recorded)
    assert all(not s.events and not s.status.description and "private" not in repr(s.attributes) for s in recorded)


def test_cutout_workers_preserve_parent_trace_context(monkeypatch, spans):
    @telemetry.operation("IRSA", "cutout")
    def one(frame, *args):
        return frame

    monkeypatch.setattr(fetch, "fetch_irsa", one)
    with telemetry._tracer.start_as_current_span("request") as parent:
        assert len(fetch.fetch_all([{"t_mjd": 1}, {"t_mjd": 2}], 1, 2, 0.1, workers=2)) == 2
    children = [s for s in spans.get_finished_spans() if s.name == "IRSA.cutout"]
    assert len(children) == 2
    assert all(s.parent.span_id == parent.get_span_context().span_id for s in children)


def test_background_build_preserves_request_context(monkeypatch, spans):
    monkeypatch.setattr(views, "JOBS", {})
    monkeypatch.setattr(views, "get_cache", lambda: SimpleNamespace(lookup=lambda _: None, manifest_url=str))

    @telemetry.operation("pipeline", "build", internal=True)
    def build(job):
        job.status = "ready"

    monkeypatch.setattr(views, "_run", build)
    with cf.ThreadPoolExecutor(max_workers=1) as pool:
        monkeypatch.setattr(views, "POOL", pool)
        with telemetry._tracer.start_as_current_span("request") as parent:
            views.create(ViewRequest(ra=1, dec=2, fov_arcmin=6, band="B1"))
    child = next(s for s in spans.get_finished_spans() if s.name == "pipeline.build")
    assert child.kind == SpanKind.INTERNAL and child.end_time >= child.start_time
    assert child.parent.span_id == parent.get_span_context().span_id


def test_no_connection_string_means_no_setup(monkeypatch):
    monkeypatch.delenv("APPLICATIONINSIGHTS_CONNECTION_STRING", raising=False)
    monkeypatch.setattr(telemetry, "_tracer", None)
    app = FastAPI()
    assert not telemetry.configure_telemetry(app)
    assert not app.user_middleware


def test_sdk_configuration_is_bounded_and_idempotent(monkeypatch):
    from azure.monitor import opentelemetry as azure_otel

    calls = []
    monkeypatch.setattr(azure_otel, "configure_azure_monitor", lambda **options: calls.append(options))
    monkeypatch.setattr(telemetry, "_tracer", None)
    monkeypatch.setenv("APPLICATIONINSIGHTS_CONNECTION_STRING", "placeholder-not-exported")
    for key in (
        "APPLICATIONINSIGHTS_CONTROLPLANE_DISABLED",
        "APPLICATIONINSIGHTS_STATSBEAT_DISABLED_ALL",
        "OTEL_EXPERIMENTAL_RESOURCE_DETECTORS",
        "OTEL_METRICS_EXPORTER",
        "OTEL_LOGS_EXPORTER",
    ):
        monkeypatch.delenv(key, raising=False)
    app = FastAPI()
    assert telemetry.configure_telemetry(app)
    assert telemetry.configure_telemetry(app)
    assert len(calls) == 1 and len(app.user_middleware) == 1
    options = calls[0]
    assert options["disable_offline_storage"] is True and options["sampling_ratio"] == 1.0
    assert options["enable_live_metrics"] is False and options["enable_performance_counters"] is False
    assert all(v == {"enabled": False} for v in options["instrumentation_options"].values())
    assert "httpx2" in options["instrumentation_options"]
    assert "placeholder-not-exported" not in repr(options)


def test_sdk_setup_failure_does_not_expose_configuration(monkeypatch, caplog):
    from azure.monitor import opentelemetry as azure_otel

    def fail(**options):
        raise ValueError("private-connection-string")

    monkeypatch.setattr(azure_otel, "configure_azure_monitor", fail)
    monkeypatch.setattr(telemetry, "_tracer", None)
    monkeypatch.setenv("APPLICATIONINSIGHTS_CONNECTION_STRING", "private-connection-string")
    assert not telemetry.configure_telemetry(FastAPI())
    assert "private-connection-string" not in caplog.text
    assert "initialization failed" in caplog.text


def test_real_sdk_emits_one_request_without_native_fastapi_duplicates():
    script = Path(__file__).with_name("sdk_telemetry_bootstrap.py")
    result = subprocess.run(
        [sys.executable, str(script)],
        check=False,
        capture_output=True,
        text=True,
        timeout=30,
        env={**os.environ, "PYTHONPATH": str(script.parents[1])},
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert '"network_attempts": 0' in result.stdout
