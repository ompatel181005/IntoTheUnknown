"""A stalled archive must release the pipeline caller without growing a work queue."""

import threading
import time

import pytest
from pyvo.dal.exceptions import DALServiceError
from requests import Response
from requests.exceptions import ReadTimeout

from app.irsa import query
from app.models import ViewRequest
from app.processing import views


def test_stalled_metadata_has_wall_clock_deadline_and_bounded_admission(monkeypatch):
    release = threading.Event()
    finished = threading.Event()
    calls = []
    monkeypatch.setattr(query, "METADATA_TIMEOUT_S", 0.025)
    monkeypatch.setattr(query, "_metadata_slots", threading.BoundedSemaphore(1))

    @query.bounded_metadata
    def stalled():
        calls.append(1)
        release.wait(2)
        finished.set()
        return []

    try:
        started = time.monotonic()
        with pytest.raises(TimeoutError):
            stalled()
        assert time.monotonic() - started < 0.5
        for _ in range(10):
            with pytest.raises(TimeoutError, match="workers are busy"):
                stalled()
        assert calls == [1]
    finally:
        release.set()
        assert finished.wait(1)
    assert query._metadata_slots.acquire(timeout=1)
    query._metadata_slots.release()


def test_timeout_of_sia_and_tap_returns_archive_error_within_combined_budget(monkeypatch):
    release = threading.Event()
    monkeypatch.setattr(query, "METADATA_TIMEOUT_S", 0.025)
    monkeypatch.setattr(query, "_metadata_slots", threading.BoundedSemaphore(2))
    monkeypatch.setattr(query, "collections", lambda: query.FALLBACK_COLLECTIONS)
    calls = []

    @query.bounded_metadata
    def stalled(*args):
        calls.append(1)
        release.wait(2)
        return []

    monkeypatch.setattr(query, "query_frames_sia", stalled)
    monkeypatch.setattr(query, "query_frames_tap", stalled)
    try:
        started = time.monotonic()
        with pytest.raises(views.ViewError) as error:
            views.live_rows(ViewRequest(ra=10, dec=20, source="live"))
        assert error.value.code == "IRSA_DOWN"
        assert len(calls) == 2
        assert time.monotonic() - started < 0.5
    finally:
        release.set()


def test_pyvo_session_sets_http_timeout_and_closes_response(monkeypatch):
    calls = []
    response = Response()
    response.status_code = 200
    response._content = b"data"

    def send(self, request, **kwargs):
        calls.append(kwargs)
        return response

    closed = []
    monkeypatch.setattr(query.Session, "send", send)
    monkeypatch.setattr(response, "close", lambda: closed.append(True))
    with query.MetadataSession() as session:
        assert session.get("https://example.invalid", timeout=None) is response
    assert calls[0]["timeout"] == (5, 30)
    assert closed == [True]


def test_metadata_transport_allows_observed_normal_sia_latency(monkeypatch):
    """Model the measured Azure p95 without a 22-second unit-test sleep."""
    observed_response_s = 21.607
    response = Response()
    response.status_code = 200
    response._content = b"metadata"
    response._content_consumed = True

    def send(self, request, **kwargs):
        connect_s, read_s = kwargs["timeout"]
        if read_s < observed_response_s:
            raise ReadTimeout("normal response arrived after the read deadline")
        assert connect_s + read_s < query.METADATA_TIMEOUT_S
        assert query.METADATA_TIMEOUT_S <= 40
        return response

    monkeypatch.setattr(query.Session, "send", send)
    with query.MetadataSession() as session:
        assert session.get("https://example.invalid") is response


def test_metadata_failure_log_keeps_http_cause_without_query_details(caplog):
    @query.bounded_metadata
    def fails():
        raise DALServiceError("sensitive URL?token=private", code=502, cause=ValueError("private"))

    with pytest.raises(DALServiceError):
        fails()
    assert "type=DALServiceError cause=ValueError http_status=502" in caplog.text
    assert "private" not in caplog.text
    assert "token=" not in caplog.text


def test_sia_uses_known_query_endpoint_without_capabilities_request(monkeypatch):
    calls = []
    service = object()

    def constructor(url, **kwargs):
        calls.append((url, kwargs))
        return service

    monkeypatch.setattr(query, "SIA2Service", constructor)
    with query.metadata_service("sia") as actual:
        assert actual is service
    assert calls[0][0] == query.Irsa.sia_url
    assert isinstance(calls[0][1]["session"], query.MetadataSession)
    assert calls[0][1]["check_baseurl"] is False


def test_collection_refresh_does_not_block_metadata_query(monkeypatch):
    release = threading.Event()
    entered = threading.Event()
    monkeypatch.setattr(query, "_collections", {"at": 0.0, "names": query.FALLBACK_COLLECTIONS})

    def discover():
        entered.set()
        release.wait(2)
        return query.FALLBACK_COLLECTIONS

    monkeypatch.setattr(query, "discover_collections", discover)
    try:
        started = time.monotonic()
        assert query.collections() == query.FALLBACK_COLLECTIONS
        assert time.monotonic() - started < 0.5
        assert entered.wait(1)
        assert query.collections() == query.FALLBACK_COLLECTIONS
    finally:
        release.set()
