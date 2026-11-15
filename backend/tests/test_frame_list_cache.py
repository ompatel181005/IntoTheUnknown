"""Saved IRSA frame lists (#96): band/FOV changes reuse them, IRSA outages fall back to them, doomed views fail fast."""

import time

import pytest

from app.cache import LocalCache
from app.irsa import query
from app.models import ViewRequest
from app.processing import views

ROWS = [
    {
        "collection": "spherex_dr1",
        "url": f"https://irsa.invalid/f{d}.fits",
        "t_mjd": 60000.0 + d,
        "band": f"SPHEREx-D{d}",
        "obs": f"f{d}",
    }
    for d in range(1, 7)
]


def req(band="B1", fov=6, source="live", ra=12.3456, dec=-45.6789):
    return ViewRequest(ra=ra, dec=dec, fov_arcmin=fov, band=band, source=source)


@pytest.fixture
def archive(monkeypatch, tmp_path):
    """IRSA double whose answer the test controls; the cache is a temp folder."""
    state = {"calls": 0, "up": True}

    def sia(ra, dec, collections):
        state["calls"] += 1
        if not state["up"]:
            raise TimeoutError("IRSA 502")
        return [{**r, "_rank": ((1, 1), ())} for r in ROWS]

    def tap(ra, dec):
        raise TimeoutError("IRSA 502")

    cache = LocalCache(tmp_path)
    monkeypatch.setattr(query, "query_frames_sia", sia)
    monkeypatch.setattr(query, "query_frames_tap", tap)
    monkeypatch.setattr(query, "collections", lambda: query.FALLBACK_COLLECTIONS)
    monkeypatch.setattr(views, "get_cache", lambda: cache)
    state["cache"] = cache
    return state


def test_other_bands_and_fovs_reuse_the_saved_list(archive):
    assert [r["band"] for r in views.live_rows(req("B1"))] == ["SPHEREx-D1"]
    assert [r["band"] for r in views.live_rows(req("B5", fov=10))] == ["SPHEREx-D5"]
    assert len(views.live_rows(req("all"))) == 6
    assert archive["calls"] == 1
    saved = archive["cache"].get_rows(views.rows_key(req()))
    assert "_rank" not in saved["rows"][0]  # tuples do not survive JSON; dedupe has already used them


def test_outage_falls_back_to_a_stale_list(archive, monkeypatch):
    views.live_rows(req("B1"))
    archive["up"] = False
    monkeypatch.setattr(views, "ROWS_TTL_S", 0)  # the saved list is now stale, so IRSA is asked first
    time.sleep(0.01)
    assert [r["band"] for r in views.live_rows(req("B2"))] == ["SPHEREx-D2"]
    assert archive["calls"] == 2


def test_outage_without_a_list_fails_then_skips_irsa_during_cooldown(archive):
    archive["up"] = False
    for _ in range(2):
        with pytest.raises(views.ViewError) as error:
            views.live_rows(req())
        assert error.value.code == "IRSA_DOWN"
    assert archive["calls"] == 1  # the second request did not wait on IRSA again


def test_success_clears_the_cooldown(archive, monkeypatch):
    archive["up"] = False
    with pytest.raises(views.ViewError):
        views.live_rows(req())
    monkeypatch.setattr(views, "IRSA_COOLDOWN_S", 0)
    archive["up"] = True
    assert views.live_rows(req())
    assert views._irsa["failed_at"] is None


def test_refresh_never_takes_a_stale_list(archive):
    views.live_rows(req())
    archive["up"] = False
    with pytest.raises(views.ViewError):
        views.live_rows(req(), max_age_s=0, allow_stale=False)


def test_doomed_live_view_is_refused_before_taking_a_render_slot(archive, monkeypatch):
    archive["up"] = False
    with pytest.raises(views.ViewError):
        views.live_rows(req())
    monkeypatch.setattr(views, "JOBS", {})
    before = views.ADMISSION._value
    with pytest.raises(views.ViewError) as error:
        views.create(req(ra=33.3, dec=-3.3))
    assert error.value.code == "IRSA_DOWN"
    assert views.ADMISSION._value == before


def test_saved_list_or_demo_pack_still_admits_during_an_outage(archive, monkeypatch):
    views.live_rows(req())  # saves the list for this position
    archive["up"] = False
    with pytest.raises(views.ViewError):
        views.live_rows(req(ra=50.0, dec=5.0))  # another position fails and starts the cooldown
    assert not views.doomed_live_view(req("B4"), archive["cache"])
    barnard = ViewRequest(ra=269.44627, dec=4.7682, fov_arcmin=6, band="B5", source="auto")
    assert not views.doomed_live_view(barnard, archive["cache"])
    assert views.doomed_live_view(req(ra=50.0, dec=5.0), archive["cache"])
