"""Restarts preserve measurements and bind them to the immutable image, without archive calls."""

import concurrent.futures as cf
import copy
import json
import threading

import numpy as np
import pytest
from fastapi.testclient import TestClient
from test_keys import FakeContainer

from app import config
from app.cache import BlobCache, LocalCache
from app.cache.blob import query_key, render_key
from app.main import app
from app.models import ViewRequest
from app.processing import analysis_cache, views

REQ = ViewRequest(ra=269.44627, dec=4.7682, fov_arcmin=6, band="B1-B2", source="saved")


def test_real_bundled_manifests_use_saved_measurement_keys():
    manifests = sorted((config.ROOT / "frontend" / "public" / "golden").glob("*/manifest.json"))
    assert len(manifests) == 5
    for path in manifests:
        manifest = json.loads(path.read_text())
        q = manifest["query"]
        qk = query_key(q["ra"], q["dec"], q["fov_arcmin"], q["band"], "saved")
        assert (
            render_key(manifest["pipeline_version"], qk, [f["obs"] for f in manifest["frames"]])
            == manifest["render_key"]
        )


@pytest.fixture(scope="module")
def prepared():
    cache = BlobCache(
        "https://test.blob.core.windows.net",
        "frames",
        container_client=FakeContainer(),
        analysis_client=FakeContainer(),
    )
    with pytest.MonkeyPatch.context() as patch:
        patch.setattr(views, "get_cache", lambda: cache)
        job = views.Job(qk=views.query_key(REQ), req=REQ)
        views.build(job)
    return job, cache


def restarted(prepared):
    job, cache = prepared
    return views.Job(qk=job.qk, req=job.req, status="ready", rk=job.rk, cache=cache, manifest_url=job.manifest_url)


def test_restart_restores_identical_measurements_with_archive_disabled(prepared, monkeypatch):
    job, cache = prepared
    expected_spectrum = views.spectrum(job, 29, 29, 0)
    expected_lightcurve = views.lightcurve(job, 29, 29)
    expected_comparison = views.comparison(job, 29, 29)
    monkeypatch.setattr(views, "build", lambda *a, **kw: pytest.fail("restart must not rebuild or contact the archive"))
    again = restarted(prepared)
    assert views.spectrum(again, 29, 29, 0) == expected_spectrum
    assert views.lightcurve(again, 29, 29) == expected_lightcurve
    assert views.comparison(again, 29, 29) == expected_comparison
    assert not any("analysis" in name for name in cache.c.store)
    assert cache.analysis.store[f"analysis/v1/{job.rk}.npz"][1].cache_control == "private, no-store"
    for original_ep, restored_ep in zip(job.epochs, again.epochs):
        for original, restored in zip(original_ep, restored_ep):
            for a, b in zip(original["_grid"], restored["_grid"]):
                np.testing.assert_array_equal(a, b)
                assert a.dtype == b.dtype


def test_local_analysis_is_outside_public_mount_and_roundtrips(prepared, tmp_path):
    job, cache = prepared
    local = LocalCache(tmp_path / "frames")
    data = cache.read_analysis(job.rk)
    local.put_analysis(job.rk, data)
    assert local.read_analysis(job.rk) == data
    assert not list(local.root.rglob("*.npz"))
    assert not list(local.analysis_root.rglob("*.tmp"))
    with pytest.raises(ValueError):
        local.read_analysis("../private")


def test_concurrent_measurements_hydrate_once(prepared, monkeypatch):
    _, cache = prepared
    again = restarted(prepared)
    reads = []
    original = cache.read_analysis
    gate = threading.Barrier(4)

    def read(rk):
        reads.append(rk)
        return original(rk)

    def measure():
        gate.wait(timeout=5)
        return views.spectrum(again, 29, 29, 0)

    monkeypatch.setattr(cache, "read_analysis", read)
    with cf.ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(lambda _: measure(), range(4)))
    assert len(reads) == 1 and all(result == results[0] for result in results)


def test_corrupt_inputs_leave_cached_image_ready_on_recovery_failure(prepared, monkeypatch):
    _, cache = prepared
    again = restarted(prepared)
    monkeypatch.setattr(cache, "read_analysis", lambda rk: b"not a zip")

    def down(*args):
        raise views.ViewError("IRSA_DOWN", "archive unavailable")

    monkeypatch.setattr(views, "build", down)
    with pytest.raises(views.ViewError, match="archive unavailable"):
        views.ensure_frames(again)
    assert again.status == "ready" and again.manifest_url == prepared[0].manifest_url


def test_sidecar_must_match_frame_list_and_grid(prepared):
    job, cache = prepared
    manifest = json.loads(cache.read(job.rk, "manifest.json"))
    wrong = copy.deepcopy(manifest)
    wrong["frames"][0]["obs"] = "some-other-exposure"
    with pytest.raises(ValueError, match="frame list"):
        analysis_cache.decode(cache.read_analysis(job.rk), job.rk, wrong)
    with pytest.raises(ValueError, match="does not match"):
        analysis_cache.decode(cache.read_analysis(job.rk), "a" * 24, manifest)


def test_legacy_render_migrates_without_changing_its_image(prepared, monkeypatch):
    job, cache = prepared
    again = restarted(prepared)
    before = dict(cache.c.store)
    monkeypatch.setattr(cache, "read_analysis", lambda rk: None)
    monkeypatch.setattr(views, "get_cache", lambda: cache)
    monkeypatch.setattr(
        cache, "point", lambda *args: pytest.fail("Recovery must not roll back a newer watcher pointer")
    )
    views.ensure_frames(again)
    assert again.epochs and again.rk == job.rk
    assert cache.c.store == before


def test_changed_archive_frames_cannot_replace_old_measurements(prepared, monkeypatch):
    job, cache = prepared
    again = restarted(prepared)
    monkeypatch.setattr(cache, "read_analysis", lambda rk: None)
    original = views.demo_frames

    def changed(*args):
        frames, origin, gaia = original(*args)
        frames[0]["obs"] = "new-frame"
        return frames, origin, gaia

    monkeypatch.setattr(views, "demo_frames", changed)
    with pytest.raises(views.ViewError) as raised:
        views.ensure_frames(again)
    assert raised.value.code == "MEASUREMENTS_UNAVAILABLE"
    assert again.rk == job.rk and not again.epochs


def test_original_image_read_failure_cannot_be_bypassed_by_local_fallback(prepared, monkeypatch, tmp_path):
    job, cache = prepared
    again = restarted(prepared)
    monkeypatch.setattr(cache, "read_analysis", lambda rk: None)
    monkeypatch.setattr(views, "get_cache", lambda: LocalCache(tmp_path / "frames"))
    monkeypatch.setattr(cache, "read", lambda *args: (_ for _ in ()).throw(OSError("Blob unreadable")))
    with pytest.raises(views.ViewError) as raised:
        views.ensure_frames(again)
    assert raised.value.code == "MEASUREMENTS_UNAVAILABLE"
    assert again.rk == job.rk and not again.epochs
    assert not (tmp_path / "frames" / "r").exists()


def test_displayed_render_guard_applies_to_all_measurement_routes(prepared, monkeypatch):
    job, _ = prepared
    monkeypatch.setattr(views, "JOBS", {job.qk: job})
    client = TestClient(app)
    for route in ("spectrum", "lightcurve", "gaia"):
        result = client.get(f"/api/views/{job.qk}/{route}?x=1&y=1&render_key={'f' * 24}")
        assert result.status_code == 503 and result.json()["error"]["code"] == "RENDER_CHANGED"
    assert client.get(f"/api/views/{job.qk}/spectrum?x=1&y=1&render_key=../x").status_code == 422
