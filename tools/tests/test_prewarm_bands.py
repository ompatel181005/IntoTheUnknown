"""No network: the band prewarm asks for exactly the views the UI opens (#96)."""

import importlib.util
from pathlib import Path

SPEC = importlib.util.spec_from_file_location(
    "prewarm_bands", Path(__file__).parents[1] / "prewarm_bands.py"
)
bands = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(bands)

TARGETS = [
    {"id": "barnard", "ra": 269.44627, "dec": 4.7682, "fov_arcmin": 6, "band": "B1-B2"},
    {"id": "wise-0855", "ra": 133.7599, "dec": -7.2422, "fov_arcmin": 6, "band": "B6"},
]
QUERY = {"ra": 10.1234, "dec": -5.5, "fov_arcmin": 10, "band": "auto", "mode": "stack", "source": "auto"}
CATALOG = {
    "objects": [
        {"id": "barnard", "preset_id": "barnard", "view": {"query": QUERY}},
        {"id": "vega", "ra_deg": 1.0, "dec_deg": 2.0, "view": {"query": QUERY}},
        {"id": "unrendered", "ra_deg": 3.0, "dec_deg": 4.0},
    ]
}


def test_presets_cover_every_band_at_their_own_position():
    jobs = bands.preset_jobs(TARGETS, bands.BANDS)
    assert len(jobs) == len(TARGETS) * len(bands.BANDS)
    assert {j["band"] for j in jobs} == set(bands.BANDS)
    wise = [j for j in jobs if j["obj"]["id"] == "wise-0855"]
    assert all(j["obj"]["ra_deg"] == 133.7599 and j["fov"] == 6 for j in wise)


def test_points_use_rendered_position_and_skip_presets_and_unrendered():
    jobs = bands.point_jobs(CATALOG, ("B1", "B5"), {"barnard"})
    assert [j["id"] for j in jobs] == ["vega:B1", "vega:B5"]
    assert jobs[0]["obj"]["ra_deg"] == QUERY["ra"] and jobs[0]["fov"] == 10


def test_request_carries_the_band_and_unchanged_position(monkeypatch):
    sent = []

    def post(url, payload, timeout=30.0):
        sent.append(payload)
        return {"status": "ready", "manifest_url": "https://blob.invalid/m.json"}

    manifest = {"query": {"ra": 269.44627, "dec": 4.7682, "fov_arcmin": 6, "band": "B5"}, "epochs": [{}]}
    monkeypatch.setattr(bands.prewarm, "http_post_json", post)
    monkeypatch.setattr(bands.prewarm, "http_get_json", lambda *a, **kw: manifest)
    job = bands.preset_jobs(TARGETS[:1], ("B5",))[0]
    res = bands.run_job(job, "https://api.invalid", 60)
    assert res["status"] == "ready" and res["id"] == "barnard:B5"
    assert sent == [{"ra": 269.44627, "dec": 4.7682, "fov_arcmin": 6, "band": "B5", "mode": "stack", "source": "auto"}]


def test_failed_render_is_retried(monkeypatch):
    calls = []
    monkeypatch.setattr(bands.time, "sleep", lambda _: None)

    def process(obj, api, fov, epoch, timeout, band):
        calls.append(band)
        ok = len(calls) > 1
        return {"status": "ready" if ok else "error", "seconds": 0.0, "passes": 1 if ok else None,
                "view": None, "error": None if ok else "QUEUE_FULL"}

    monkeypatch.setattr(bands.prewarm, "process_object", process)
    res = bands.run_job(bands.preset_jobs(TARGETS[:1], ("B2",))[0], "https://api.invalid", 60)
    assert res["status"] == "ready" and calls == ["B2", "B2"]
