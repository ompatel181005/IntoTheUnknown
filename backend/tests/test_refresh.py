"""POST /internal/refresh and GET /api/status (issue #25). No network: IRSA and the renderer are stubbed."""

import json

from fastapi.testclient import TestClient

from app import config, refresh
from app.cache import LocalCache
from app.main import app
from app.processing import views

client = TestClient(app)
KEY = "test-refresh-key"
REQ = refresh.pinned_views()[0]
ROWS = [
    {"obs": "level2_a_1D1", "t_mjd": 60900.0, "collection": "spherex_qr3"},
    {"obs": "level2_b_1D1", "t_mjd": 60901.0, "collection": "spherex_qr3"},
]
MANIFEST = {"frames": [{"obs": r["obs"], "t_mjd": r["t_mjd"], "collection": r["collection"]} for r in ROWS]}


class Submitted:
    """Stands in for the refresh thread: records the call, runs nothing."""

    def __init__(self):
        self.calls = []

    def submit(self, fn, *args):
        self.calls.append((fn, args))


def test_wrong_missing_or_unconfigured_key_is_rejected(monkeypatch):
    worker = Submitted()
    monkeypatch.setattr(refresh, "_worker", worker)
    monkeypatch.setattr(config, "REFRESH_KEY", KEY)
    for headers in ({}, {"X-Refresh-Key": "nope"}, {"X-Refresh-Key": KEY + "x"}, {"X-Refresh-Key": ""}):
        r = client.post("/internal/refresh", json={"reason": "catalog_change"}, headers=headers)
        assert r.status_code == 401 and r.json()["error"]["code"] == "BAD_REFRESH_KEY"
    monkeypatch.setattr(config, "REFRESH_KEY", "")
    r = client.post("/internal/refresh", headers={"X-Refresh-Key": ""})
    assert r.status_code == 503 and r.json()["error"]["code"] == "REFRESH_DISABLED"
    assert worker.calls == []


def test_right_key_queues_the_five_pinned_live_views_once(monkeypatch):
    worker = Submitted()
    monkeypatch.setattr(refresh, "_worker", worker)
    monkeypatch.setattr(config, "REFRESH_KEY", KEY)
    body = {"reason": "catalog_change", "catalog_version": "c1"}  # what functions/function_app.py sends
    try:
        r = client.post("/internal/refresh", json=body, headers={"X-Refresh-Key": KEY})
        assert r.status_code == 202 and r.json() == {"queued": 5, "running": True}
        fn, (reqs,) = worker.calls[0]
        assert fn is refresh._refresh_pinned and all(q.source == "live" for q in reqs)
        again = client.post("/internal/refresh", json=body, headers={"X-Refresh-Key": KEY})
        assert again.status_code == 202 and again.json()["queued"] == 0  # a run is already pending
        assert len(worker.calls) == 1
    finally:
        refresh._running.release()


def test_frames_changed():
    newer = {"obs": "level2_c_1D1", "t_mjd": 60950.0, "collection": "spherex_qr3"}
    older = {"obs": "level2_z_1D1", "t_mjd": 60899.0, "collection": "spherex_qr3"}  # thinned out of the render
    assert not refresh.frames_changed(MANIFEST, ROWS)
    assert not refresh.frames_changed(MANIFEST, ROWS + [older])
    assert refresh.frames_changed(MANIFEST, ROWS + [newer])
    assert refresh.frames_changed(MANIFEST, ROWS + [{**older, "collection": "spherex_dr2"}])
    assert refresh.frames_changed(MANIFEST, [newer])  # every frame replaced
    assert refresh.frames_changed({"frames": []}, ROWS) and not refresh.frames_changed({"frames": []}, [])


def _cached(monkeypatch, tmp_path, rows):
    cache = LocalCache(tmp_path)
    qk = views.query_key(REQ)
    cache.put_render("rk-old", MANIFEST, {})
    cache.point(qk, "rk-old", "spherex_qr3")
    built = []

    def build(job):
        built.append(job)
        job.rk, job.status = "rk-new", "ready"

    monkeypatch.setattr(views, "get_cache", lambda: cache)
    monkeypatch.setattr(views, "live_rows", lambda req: rows)
    monkeypatch.setattr(views, "build", build)
    monkeypatch.setattr(views, "JOBS", {})
    return qk, built


def test_unchanged_frame_set_causes_no_re_render(monkeypatch, tmp_path):
    _, built = _cached(monkeypatch, tmp_path, ROWS)
    assert refresh.refresh_view(REQ) is False
    assert built == [] and views.JOBS == {}


def test_new_frames_re_render_and_swap_only_after_the_build(monkeypatch, tmp_path):
    rows = ROWS + [{"obs": "level2_c_1D1", "t_mjd": 60950.0, "collection": "spherex_qr3"}]
    qk, built = _cached(monkeypatch, tmp_path, rows)
    assert refresh.refresh_view(REQ) is True
    assert len(built) == 1 and views.JOBS[qk] is built[0]
    assert json.loads((tmp_path / "r" / "rk-old" / "manifest.json").read_text()) == MANIFEST  # old link still valid


def test_failed_views_are_retried_then_given_up_without_touching_the_old_render(monkeypatch, tmp_path):
    rows = ROWS + [{"obs": "level2_c_1D1", "t_mjd": 60950.0, "collection": "spherex_qr3"}]
    qk, built = _cached(monkeypatch, tmp_path, rows)
    good_build = views.build
    waits, attempts = [], []

    def flaky(job):  # IRSA is down for the first pass, back for the retry
        attempts.append(job)
        if len(attempts) == 1:
            raise views.ViewError("IRSA_DOWN", "down")
        good_build(job)

    monkeypatch.setattr(refresh.time, "sleep", waits.append)
    monkeypatch.setattr(views, "build", flaky)
    refresh._running.acquire()
    refresh._refresh_pinned([REQ])
    assert waits == [refresh.RETRY_DELAYS_S[0]] and len(attempts) == 2 and views.JOBS[qk] is built[0]

    def boom(job):
        raise views.ViewError("IRSA_DOWN", "down")

    waits.clear()
    monkeypatch.setattr(views, "build", boom)
    monkeypatch.setattr(views, "JOBS", {})
    refresh._running.acquire()  # the first run released it
    refresh._refresh_pinned([REQ])  # must not raise, and must release the run lock
    assert waits == list(refresh.RETRY_DELAYS_S)
    assert refresh._running.acquire(blocking=False)
    refresh._running.release()
    assert views.JOBS == {} and LocalCache(tmp_path).lookup(qk)["render_key"] == "rk-old"


def test_status_is_null_until_the_watcher_has_run_then_reports_its_catalog(monkeypatch, tmp_path):
    monkeypatch.setattr(views, "get_cache", lambda: LocalCache(tmp_path))
    assert client.get("/api/status").json() == {"catalog": None}
    public = {
        "catalog_version": "c20261114-2-61350",
        "collections": ["spherex_dr1", "spherex_qr3"],
        "latest_frame_mjd": 61350.2,
        "checked_at": "2026-11-15T06:00:00+00:00",
    }
    (tmp_path / "meta").mkdir()
    (tmp_path / "meta" / "catalog.json").write_text(json.dumps({**public, "private": "dropped"}))
    assert client.get("/api/status").json() == {"catalog": public}
