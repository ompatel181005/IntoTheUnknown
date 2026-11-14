"""End-to-end checks against the bundled demo pack (no network)."""

import time

import numpy as np
from fastapi.testclient import TestClient

from app import config
from app.main import app

client = TestClient(app)
BARNARD = {"ra": 269.44627, "dec": 4.7682, "fov_arcmin": 6, "band": "B1-B2"}


def wait_ready(body: dict, timeout: float = 60) -> dict:
    while body["status"] not in ("ready", "error"):
        assert time.time() < timeout + start, "view did not finish"
        time.sleep(0.2)
        body = client.get(f"/api/views/{view_id}").json()
    return body


def test_health_and_targets():
    assert client.get("/api/health").json()["ok"] is True
    ids = [t["id"] for t in client.get("/api/targets").json()]
    assert ids == ["barnard", "eps-ind-b", "wise-0855", "rw-aur", "r-dra"]


def test_barnard_view_from_demo_pack():
    global start, view_id
    start = time.time()
    r = client.post("/api/views", json=BARNARD)
    assert r.status_code in (200, 202)
    view_id = r.json()["view_id"]
    body = wait_ready(r.json() if r.status_code == 202 else {"status": "ready", **r.json()})
    assert body["status"] == "ready", body
    m = client.get(body["manifest_url"]).json()
    assert m["source"] == "golden" and len(m["epochs"]) >= 2
    assert m["origin"]["kind"] == "saved" and m["origin"]["files"] > 0
    nx, ny = m["grid"]["nx"], m["grid"]["ny"]
    arr = np.frombuffer(
        client.get(body["manifest_url"].replace("manifest.json", m["epochs"][0]["image"])).content, "<f4"
    )
    assert arr.size == nx * ny and np.isfinite(arr).mean() > 0.5

    lc = client.get(f"/api/views/{view_id}/lightcurve", params={"x": nx // 2, "y": ny // 2}).json()
    assert len(lc["points"]) >= 2
    sp = client.get(f"/api/views/{view_id}/spectrum", params={"x": nx // 2, "y": ny // 2, "epoch": 0}).json()
    assert len(sp["points"]) == m["epochs"][0]["n_frames"]


def test_bad_request_is_422():
    assert client.post("/api/views", json={**BARNARD, "fov_arcmin": 7}).status_code == 422


def test_cache_dir_exists():
    assert config.CACHE_DIR.exists()


def test_saved_only_rejects_unknown_position():
    r = client.post("/api/views", json={**BARNARD, "ra": 10.0, "dec": 10.0, "source": "saved"})
    vid = r.json()["view_id"]
    for _ in range(50):
        body = client.get(f"/api/views/{vid}").json()
        if body["status"] == "error":
            break
        time.sleep(0.1)
    assert body["error"]["code"] == "NOT_SAVED"


def test_measurement_errors_use_the_api_error_shape():
    for path in ("/api/views/nope", "/api/views/nope/spectrum?x=1&y=1", "/api/views/nope/lightcurve?x=1&y=1"):
        r = client.get(path)
        assert r.status_code == 404 and r.json()["error"]["code"] == "UNKNOWN_VIEW", path


def test_measurement_inputs_are_bounded():
    for q in ("x=30&y=30&r_px=4", "x=30&y=30&r_px=-1", "x=nan&y=30", "x=-1&y=30"):
        assert client.get(f"/api/views/{view_id}/lightcurve?{q}").status_code == 422, q
    assert client.get(f"/api/views/{view_id}/spectrum?x=-1&y=0").status_code == 422


def test_rebuild_failure_is_not_a_bare_500(monkeypatch):
    from app.processing import views

    def down(job):
        raise views.ViewError("IRSA_DOWN", "archive down")

    job = views.JOBS[view_id]
    monkeypatch.setattr(job, "epochs", [])  # as after a restart
    monkeypatch.setattr(views, "build", down)
    r = client.get(f"/api/views/{view_id}/spectrum?x=1&y=1")
    assert r.status_code == 503 and r.json()["error"]["code"] == "IRSA_DOWN"
