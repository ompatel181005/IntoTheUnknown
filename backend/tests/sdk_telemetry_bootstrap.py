"""Exercise the real Azure SDK in a subprocess, with ingestion replaced and networking forbidden."""

import json
import os
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import telemetry

os.environ["APPLICATIONINSIGHTS_CONNECTION_STRING"] = (
    "InstrumentationKey=00000000-0000-0000-0000-000000000000;IngestionEndpoint=https://127.0.0.1:9/"
)
# Inherited SDK defaults must not bypass this application's networking/privacy controls.
os.environ["APPLICATIONINSIGHTS_CONTROLPLANE_DISABLED"] = "false"
os.environ["APPLICATIONINSIGHTS_STATSBEAT_DISABLED_ALL"] = "false"
os.environ["OTEL_EXPERIMENTAL_RESOURCE_DETECTORS"] = "azure_vm"
captured, network = [], []


def deny(*args, **kwargs):
    network.append("attempted")
    raise AssertionError("Network is forbidden in SDK bootstrap verification")


with patch("socket.create_connection", deny), patch("socket.getaddrinfo", deny):
    app = FastAPI(telemetry=telemetry.FASTAPI_TELEMETRY)
    # Match production import order: configure applies guards before importing the Azure SDK.
    assert telemetry.configure_telemetry(app)
    from azure.monitor.opentelemetry.exporter import AzureMonitorTraceExporter
    from opentelemetry import trace
    from opentelemetry.sdk.trace.export import SpanExportResult

    def export(self, spans, **kwargs):
        captured.extend(self._span_to_envelope(span) for span in spans)
        return SpanExportResult.SUCCESS

    with patch.object(AzureMonitorTraceExporter, "export", export):

        @telemetry.operation("IRSA", "cutout", none_is_failure=True)
        def cutout():
            return None

        @app.post("/api/views")
        def view():
            telemetry.record_cache_hit(True, "memory")
            cutout()
            return {"ok": True}

        with TestClient(app) as client:
            assert client.post("/api/views?sig=never-export-me").status_code == 200
        provider = trace.get_tracer_provider()
        assert provider.force_flush(5000)
        provider.shutdown()
    requests = [e for e in captured if e.data.base_type == "RequestData"]
    dependencies = [e for e in captured if e.data.base_type == "RemoteDependencyData"]
    assert len(requests) == len(dependencies) == 1, [e.data.base_type for e in captured]
    assert requests[0].data.base_data.name == "POST /api/views"
    assert requests[0].tags["ai.cloud.role"] == "spherex-blink-api"
    assert str(requests[0].data.base_data.properties["cache.hit"]).lower() == "true"
    assert dependencies[0].data.base_data.success is False
    assert "never-export-me" not in repr([e.as_dict() for e in captured])
    assert not network, network
print(json.dumps({"requests": len(requests), "dependencies": len(dependencies), "network_attempts": len(network)}))
