"""Cutout downloads use bounded memory and release resources without archive traffic."""

import concurrent.futures as cf
import gzip
import io
import json
import threading
import urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
import pytest
from astropy.io import fits

from app import config
from app.irsa import fetch


@pytest.fixture
def cutout_bytes():
    buffer = io.BytesIO()
    fits.PrimaryHDU(np.ones((4, 4), dtype="f4")).writeto(buffer)
    return buffer.getvalue()


@pytest.fixture
def extract(monkeypatch):
    monkeypatch.setattr(fetch, "_extract", lambda hdul, ra, dec: {"image": hdul[0].data.copy()})


@pytest.fixture
def cutout_server(cutout_bytes):
    state = {"incomplete": 0, "calls": 0}

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            assert "center=1,2d&size=0.1" in self.path
            state["calls"] += 1
            extra = 100 if state["incomplete"] else 0
            state["incomplete"] = max(0, state["incomplete"] - 1)
            self.send_response(200)
            self.send_header("Content-Length", str(len(cutout_bytes) + extra))
            self.end_headers()
            self.wfile.write(cutout_bytes)

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield {"url": f"http://127.0.0.1:{server.server_port}/cutout.fits"}, state
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


def test_parallel_downloads_leave_no_temp_files(monkeypatch, tmp_path, cutout_server, extract):
    # Real HTTP + real FITS parser: the previous URL reader leaves astropy-download-* here.
    monkeypatch.setattr("tempfile.tempdir", str(tmp_path))
    frame, _ = cutout_server
    with cf.ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(lambda _: fetch.fetch_irsa(frame, 1, 2, 0.1), range(12)))
    assert all(r["source"] == "irsa" and np.array_equal(r["image"], np.ones((4, 4))) for r in results)
    assert list(tmp_path.iterdir()) == []


def test_premature_http_close_retries_before_fits_parsing(monkeypatch, cutout_server, extract):
    frame, state = cutout_server
    state["incomplete"] = 1
    sleeps = []
    monkeypatch.setattr(fetch.time, "sleep", sleeps.append)
    assert fetch.fetch_irsa(frame, 1, 2, 0.1)["source"] == "irsa"
    assert state["calls"] == 2
    assert sleeps == [2]


class Response(io.BytesIO):
    def __init__(self, body):
        super().__init__(body)
        self.headers = {}

    def read(self, size=-1):
        self.read_size = size
        return super().read(size)


def test_oversized_response_is_bounded_and_closed(monkeypatch):
    monkeypatch.setattr(fetch, "MAX_CUTOUT_BYTES", 20)
    response = Response(b"x" * 100)
    monkeypatch.setattr(fetch.urllib.request, "urlopen", lambda *a, **k: response)
    assert fetch.fetch_irsa({"url": "https://example.invalid/cutout"}, 1, 2, 0.1) is None
    assert response.read_size == 21
    assert response.closed


def test_real_science_arrays_survive_buffer_close(monkeypatch):
    folder = config.DEMO_DIR / "barnard"
    manifest = json.loads((folder / "manifest.json").read_text())
    meta = manifest["files"][0]
    ra, dec = manifest["center"]
    body = gzip.decompress((folder / meta["file"]).read_bytes())
    with fits.open(io.BytesIO(body), memmap=False) as hdul:
        expected = fetch._extract(hdul, ra, dec)
    response = Response(body)
    monkeypatch.setattr(fetch.urllib.request, "urlopen", lambda *a, **k: response)
    result = fetch.fetch_irsa({"url": "https://example.invalid/cutout"}, ra, dec, 0.1)
    assert response.closed
    for name in ("image", "var", "flags"):
        np.testing.assert_array_equal(result[name], expected[name])
    assert result["lam_um"] == expected["lam_um"]
    assert result["wcs_header"] == expected["wcs_header"]


def test_response_closes_when_fits_extraction_fails(monkeypatch, cutout_bytes):
    response = Response(cutout_bytes)
    monkeypatch.setattr(fetch.urllib.request, "urlopen", lambda *a, **k: response)

    def fail(*args):
        raise ValueError("bad spectral metadata")

    monkeypatch.setattr(fetch, "_extract", fail)
    with pytest.raises(ValueError, match="spectral metadata"):
        fetch.fetch_irsa({"url": "https://example.invalid/cutout"}, 1, 2, 0.1)
    assert response.closed


@pytest.mark.parametrize("error", [TimeoutError(), urllib.error.HTTPError("", 503, "", None, None)])
def test_transient_failure_retries_with_configured_timeout(monkeypatch, cutout_bytes, extract, error):
    calls, sleeps = [], []
    response = Response(cutout_bytes)

    def open_response(url, timeout):
        calls.append(timeout)
        if len(calls) == 1:
            raise error
        return response

    monkeypatch.setattr(fetch.urllib.request, "urlopen", open_response)
    monkeypatch.setattr(fetch.time, "sleep", sleeps.append)
    result = fetch.fetch_irsa({"url": "https://example.invalid/cutout"}, 1, 2, 0.1)
    assert result["source"] == "irsa"
    assert calls == [fetch.IRSA_TIMEOUT_S] * 2
    assert sleeps == [2]
    assert response.closed


def test_permanent_http_failure_does_not_retry(monkeypatch):
    calls = []

    def not_found(*args, **kwargs):
        calls.append(1)
        raise urllib.error.HTTPError("", 404, "", None, None)

    monkeypatch.setattr(fetch.urllib.request, "urlopen", not_found)
    assert fetch.fetch_irsa({"url": "https://example.invalid/cutout"}, 1, 2, 0.1) is None
    assert calls == [1]


def test_rejected_cutout_uses_existing_s3_fallback(monkeypatch):
    monkeypatch.setattr(fetch, "MAX_CUTOUT_BYTES", 20)
    monkeypatch.setattr(fetch.urllib.request, "urlopen", lambda *a, **k: Response(b"x" * 100))
    monkeypatch.setattr(fetch, "fetch_s3", lambda frame, *a: {**frame, "source": "s3"})
    result = fetch.fetch_all([{"url": "https://example.invalid/cutout", "t_mjd": 1}], 1, 2, 0.1)
    assert result[0]["source"] == "s3"


def test_s3_is_tried_first_and_irsa_is_the_fallback(monkeypatch):
    calls = []
    monkeypatch.setattr(
        fetch, "fetch_s3", lambda f, *a: calls.append("s3") or (None if f["t_mjd"] == 2 else {**f, "source": "s3"})
    )
    monkeypatch.setattr(fetch, "fetch_irsa", lambda f, *a: calls.append("irsa") or {**f, "source": "irsa"})
    out = fetch.fetch_all([{"t_mjd": 1}, {"t_mjd": 2}], 1, 2, 0.1, workers=1)
    assert [r["source"] for r in out] == ["s3", "irsa"]
    assert calls.count("irsa") == 1


def test_s3_reader_dependency_is_installed():
    # fetch_s3 swallows every exception, so a missing package would silently disable the S3 path.
    import s3fs  # noqa: F401


def test_collection_lookup_is_cached_and_falls_back(monkeypatch):
    from app.irsa import query

    calls = []
    called = threading.Event()

    def lookup():
        calls.append(1)
        called.set()
        raise TimeoutError

    monkeypatch.setattr(query, "discover_collections", lookup)
    monkeypatch.setattr(query, "_collections", {"at": 0.0, "names": []})
    assert query.collections() == query.FALLBACK_COLLECTIONS
    assert query.collections() == query.FALLBACK_COLLECTIONS
    assert called.wait(1)
    assert len(calls) == 1


def test_profile_records_read_metadata_and_local_extraction_without_changing_science():
    from app.telemetry import profile_operations

    folder = config.DEMO_DIR / "barnard"
    manifest = json.loads((folder / "manifest.json").read_text())
    meta = manifest["files"][0]
    ra, dec = manifest["center"]
    with fits.open(folder / meta["file"], memmap=False) as hdul:
        expected = fetch._extract(hdul, ra, dec)
        with profile_operations() as rows:
            actual = fetch._extract(hdul, ra, dec)
    assert [row["operation"] for row in rows] == ["FITS.metadata_wcs", "FITS.array_read", "FITS.science_extract"]
    assert all(row["success"] and row["seconds"] >= 0 for row in rows)
    for key in ("image", "var", "flags"):
        np.testing.assert_array_equal(actual[key], expected[key])


def test_s3_uses_only_window_sections_and_preserves_local_cutout_values():
    # Use a real saved FITS file behind a guard that forbids image .data access.
    folder = config.DEMO_DIR / "barnard"
    manifest = json.loads((folder / "manifest.json").read_text())
    meta = manifest["files"][0]
    ra, dec = manifest["center"]
    with fits.open(folder / meta["file"], memmap=False) as hdul:
        expected = fetch._extract(hdul, ra, dec)
    with fits.open(folder / meta["file"], memmap=False) as hdul:

        class SectionOnly:
            def __init__(self, hdu):
                self.hdu = hdu

            def __getattr__(self, name):
                if name == "data":
                    raise AssertionError("S3 image arrays must use sections")
                return getattr(self.hdu, name)

        class Guarded:
            def __getitem__(self, key):
                hdu = hdul[key]
                return SectionOnly(hdu) if hdu.name in {"IMAGE", "ZODI", "VARIANCE", "FLAGS"} else hdu

            def __iter__(self):
                return iter(hdul)

        # Exercise array retrieval through the guard; spectral WCS needs the original HDUList.
        sl = (slice(0, 4), slice(1, 5))
        actual = fetch._science_arrays(fetch._read_arrays(Guarded(), sl, True))
        for key in ("image", "var", "flags"):
            if expected[key] is None:
                assert actual[key] is None
            else:
                np.testing.assert_array_equal(actual[key], expected[key][sl])
