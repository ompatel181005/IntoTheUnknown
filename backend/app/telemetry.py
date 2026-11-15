"""Opt-in Azure request and operation spans, without request payloads or disk buffering."""

import functools
import logging
import os
import time
from contextlib import contextmanager
from contextvars import ContextVar

_tracer = None
log = logging.getLogger(__name__)
_profile = ContextVar("operation_profile", default=None)
# Newer FastAPI releases also trace natively when a global provider is configured.
FASTAPI_TELEMETRY = {"tracing": False, "metrics": False, "logs": False, "auto_configure": False}
_INSTRUMENTATIONS = (
    "azure_sdk",
    "django",
    "fastapi",
    "flask",
    "httpx",
    "httpx2",
    "psycopg2",
    "requests",
    "urllib",
    "urllib3",
)


def configure_telemetry(app) -> bool:
    """Enable only when a Container Apps secret supplies the connection string."""
    global _tracer
    if not os.environ.get("APPLICATIONINSIGHTS_CONNECTION_STRING"):
        return False
    if getattr(app.state, "telemetry_enabled", False):
        return True
    try:
        if _tracer is None:
            # Avoid optional startup calls, process metrics, log capture and local retry files.
            for name, value in {
                "APPLICATIONINSIGHTS_CONTROLPLANE_DISABLED": "true",
                "APPLICATIONINSIGHTS_STATSBEAT_DISABLED_ALL": "true",
                "OTEL_EXPERIMENTAL_RESOURCE_DETECTORS": "",
                "OTEL_METRICS_EXPORTER": "None",
                "OTEL_LOGS_EXPORTER": "None",
            }.items():
                os.environ[name] = value
            from azure.monitor.opentelemetry import configure_azure_monitor
            from opentelemetry import trace
            from opentelemetry.sdk.resources import Resource

            configure_azure_monitor(
                resource=Resource({"service.name": "spherex-blink-api", "service.version": app.version}),
                instrumentation_options={name: {"enabled": False} for name in _INSTRUMENTATIONS},
                sampling_ratio=1.0,
                enable_live_metrics=False,
                enable_performance_counters=False,
                disable_offline_storage=True,
                logger_name=__name__,
            )
            _tracer = trace.get_tracer("spherex.telemetry")
        app.add_middleware(RequestTelemetry)
        app.state.telemetry_enabled = True
        return True
    except Exception:
        # Configuration errors must not take down the app or print a connection string.
        log.warning("Azure telemetry initialization failed; continuing without request export")
        return False


class RequestTelemetry:
    """Measure API routes only; never inspect a body, query string, headers or client address."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        path = scope.get("path", "")
        if scope["type"] != "http" or not path.startswith("/api/") or path == "/api/health":
            await self.app(scope, receive, send)
            return
        from opentelemetry.trace import SpanKind, StatusCode

        method = scope["method"]
        if method not in {"GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"}:
            method = "OTHER"
        status = 500

        async def traced_send(message):
            nonlocal status
            if message["type"] == "http.response.start":
                status = message["status"]
            await send(message)

        with _tracer.start_as_current_span(
            "HTTP /api",
            kind=SpanKind.SERVER,
            record_exception=False,
            set_status_on_exception=False,
        ) as span:
            try:
                await self.app(scope, receive, traced_send)
            except Exception as error:
                span.set_attribute("error.type", type(error).__name__)
                span.set_status(StatusCode.ERROR)
                raise
            finally:
                route = getattr(scope.get("route"), "path", None) or "/api/{unmatched}"
                span.update_name(f"{method} {route}")
                span.set_attributes({"http.method": method, "http.route": route, "http.status_code": status})
                if status >= 400:
                    span.set_status(StatusCode.ERROR)


def record_cache_hit(hit: bool, layer: str) -> None:
    """Tag the active POST request at the actual cache decision, including inflight reuse."""
    if _tracer is not None:
        from opentelemetry import trace

        trace.get_current_span().set_attributes({"cache.hit": hit, "cache.layer": layer})


@contextmanager
def profile_operations():
    """Opt-in in-memory timings for the diagnostic CLI; no payloads or global log capture."""
    rows = []
    token = _profile.set(rows)
    try:
        yield rows
    finally:
        _profile.reset(token)


def operation(service: str, name: str, *, none_is_failure=False, internal=False):
    """Trace a logical archive operation, including failures caught by the fallback caller."""

    def decorate(function):
        @functools.wraps(function)
        def wrapped(*args, **kwargs):
            rows = _profile.get()
            if rows is None:
                return traced(*args, **kwargs)
            started = time.perf_counter()
            success = False
            try:
                result = traced(*args, **kwargs)
                success = not (none_is_failure and result is None)
                return result
            finally:
                rows.append(
                    {"operation": f"{service}.{name}", "seconds": time.perf_counter() - started, "success": success}
                )

        def traced(*args, **kwargs):
            if _tracer is None:
                return function(*args, **kwargs)
            from opentelemetry.trace import SpanKind, StatusCode

            with _tracer.start_as_current_span(
                f"{service}.{name}",
                kind=SpanKind.INTERNAL if internal else SpanKind.CLIENT,
                attributes={"dependency.service": service, "dependency.operation": name},
                record_exception=False,
                set_status_on_exception=False,
            ) as span:
                try:
                    result = function(*args, **kwargs)
                except Exception as error:
                    span.set_attribute("error.type", type(error).__name__)
                    span.set_status(StatusCode.ERROR)
                    raise
                if none_is_failure and result is None:
                    span.set_attribute("error.type", "NoResult")
                    span.set_status(StatusCode.ERROR)
                return result

        return wrapped

    return decorate
