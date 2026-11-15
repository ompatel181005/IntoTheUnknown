"""No network/builds: test both cached-ready and asynchronous-ready producers."""

import importlib.util
from pathlib import Path

import pytest

SPEC = importlib.util.spec_from_file_location(
    "prewarm_points", Path(__file__).parents[1] / "prewarm_points.py"
)
prewarm = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(prewarm)

OBJECT = {"id": "test", "ra_deg": 269.446077, "dec_deg": 4.770710}
ACTUAL = {"ra": 269.446078, "dec": 4.770709, "fov_arcmin": 6, "band": "auto"}


@pytest.mark.parametrize("polled", [False, True])
def test_actual_manifest_query_is_stored_and_request_source_preserved(
    monkeypatch, polled
):
    run(monkeypatch, polled, {"query": ACTUAL, "epochs": [{}, {}]})
    result = prewarm.process_object(OBJECT, "https://api.invalid", 6, 2026, 60)
    assert result["status"] == "ready"
    assert result["passes"] == 2
    assert result["view"]["query"] == {**ACTUAL, "mode": "stack", "source": "auto"}
    assert result["view"]["query"]["ra"] != OBJECT["ra_deg"]


def run(monkeypatch, polled, manifest):
    monkeypatch.setattr(prewarm.time, "sleep", lambda _: None)
    monkeypatch.setattr(
        prewarm,
        "http_post_json",
        lambda *a, **kw: (
            {"status": "queued", "status_url": "/status"}
            if polled
            else {
                "status": "ready",
                "manifest_url": "https://blob.invalid/manifest.json",
            }
        ),
    )
    monkeypatch.setattr(
        prewarm,
        "http_get_json",
        lambda url, **kw: (
            {"status": "ready", "manifest_url": "https://blob.invalid/manifest.json"}
            if url.endswith("/status")
            else manifest
        ),
    )


@pytest.mark.parametrize("polled", [False, True])
@pytest.mark.parametrize(
    "manifest",
    [
        None,
        [],
        {},
        {"query": ACTUAL, "epochs": None},
        *[
            {"query": {**ACTUAL, **change}, "epochs": []}
            for change in [
                {"ra": 270},
                {"dec": 5},
                {"ra": float("nan")},
                {"dec": float("inf")},
                {"ra": True},
                {"ra": "269.446078"},
                {"fov_arcmin": 10},
                {"band": "B6"},
                {"source": "live"},
                {"mode": "frames"},
            ]
        ],
    ],
)
def test_bad_manifest_returns_error_without_attaching_a_view(
    monkeypatch, polled, manifest
):
    run(monkeypatch, polled, manifest)
    result = prewarm.process_object(OBJECT, "https://api.invalid", 6, 2026, 60)
    assert result["status"] == "error"
    assert result["view"] is None
    assert result["passes"] is None


def test_cache_tolerance_uses_the_same_bucket_not_only_a_loose_distance():
    requested = {**ACTUAL, "ra": 269.446049, "mode": "stack", "source": "auto"}
    with pytest.raises(RuntimeError, match="another sky field"):
        prewarm.validated_manifest_query(
            {"query": {**ACTUAL, "ra": 269.446051}, "epochs": []}, requested
        )
