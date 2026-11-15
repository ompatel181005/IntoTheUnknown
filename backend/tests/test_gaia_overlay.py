"""Gaia overlay (issue #29): pixel tracks per epoch, per-epoch matches and the match label. Offline."""

import time

import numpy as np
from astropy.coordinates import SkyCoord
from fastapi.testclient import TestClient

from app import config
from app.main import app
from app.processing import align, gaia, stack

CENTER = (269.44627, 4.7682)  # Barnard's Star preset centre (docs/TARGETS.md)
EPOCHS_MJD = [60920.0, 61110.0, 61280.0]  # three SPHEREx passes, Sep 2025 to Sep 2026
RNG = np.random.default_rng(29)
B = gaia.PRESETS["barnard"]


def grid():
    return stack.common_grid(*CENTER, 6)


def linear_radec(ra, dec, pmra, pmdec, mjd):
    """Independent check: straight-line proper motion from J2016.0, no parallax (Barnard's is <= 0.09 px)."""
    dt = (mjd - 57388.5) / 365.25
    return ra + pmra * dt / 3.6e6 / np.cos(np.radians(dec)), dec + pmdec * dt / 3.6e6


def gaussian(shape, x0, y0, flux, sigma=1.0):
    yy, xx = np.mgrid[0 : shape[0], 0 : shape[1]]
    g = np.exp(-((xx - x0) ** 2 + (yy - y0) ** 2) / (2 * sigma**2))
    return flux * g / g.sum()


def catalog(rows):
    cat = np.empty(len(rows), gaia.GAIA_DTYPE)
    for i, r in enumerate(rows):
        cat[i] = r
    return cat


FIELD = [(269.4380, 4.7600, 15.0), (269.4540, 4.7740, 14.0), (269.4420, 4.7790, 15.5)]  # static (ra, dec, G)


def synthetic_view(extra_px=None):
    """Epoch stacks with Barnard's Star injected on its straight-line track, plus static field stars."""
    w, shape = grid()
    stacks, injected = [], []
    for mjd in EPOCHS_MJD:
        img = RNG.normal(0, 0.01, shape)
        bx, by = w.world_to_pixel(SkyCoord(*linear_radec(B.ra, B.dec, B.pmra, B.pmdec, mjd), unit="deg"))
        injected.append((float(bx), float(by)))
        img += gaussian(shape, bx, by, 80.0)
        for ra, dec, _ in FIELD:
            fx, fy = w.world_to_pixel(SkyCoord(ra, dec, unit="deg"))
            img += gaussian(shape, fx, fy, 20.0)
        if extra_px:
            img += gaussian(shape, *extra_px, 20.0)
        stacks.append(img)
    cat = catalog(
        [(B.source_id, B.ra, B.dec, B.pmra, B.pmdec, B.parallax, B.radial_velocity, 8.19)]
        + [(1000 + i, ra, dec, 0.0, 0.0, 0.5, np.nan, g) for i, (ra, dec, g) in enumerate(FIELD)]
    )
    return w, stacks, cat, injected


def test_barnard_track_lands_on_the_injected_star_in_every_epoch():
    w, stacks, cat, injected = synthetic_view()
    result = gaia.overlay(cat, EPOCHS_MJD, stacks, w)
    barnard = next(s for s in result["stars"] if s["source_id"] == B.source_id)
    for (tx, ty), (ix, iy) in zip(barnard["track_px"], injected):
        assert np.hypot(tx - ix, ty - iy) < 0.3, (tx, ty, ix, iy)
    assert barnard["matched"] == [True, True, True]
    # It really moves: about 1.7 px north over the year (docs/TARGETS.md).
    (x0, y0), (x2, y2) = barnard["track_px"][0], barnard["track_px"][-1]
    assert 1.3 < y2 - y0 < 2.1 and abs(x2 - x0) < 0.3
    assert result["epochs_mjd"] == EPOCHS_MJD and result["unexplained"] == []
    assert all(s["matched"] == [True, True, True] for s in result["stars"])


def test_match_label_tells_gaia_stars_from_an_unexplained_source():
    w, stacks, cat, injected = synthetic_view(extra_px=(14.0, 44.0))  # a source Gaia doesn't list
    result = gaia.overlay(cat, EPOCHS_MJD, stacks, w)
    hit = gaia.match_label(result, stacks, *injected[1], epoch=1)
    assert hit["label"] == "match" and hit["source_id"] == B.source_id and hit["sep_px"] < gaia.MATCH_PX
    miss = gaia.match_label(result, stacks, 14.0, 44.0, epoch=1)
    assert miss["label"] == "no_match" and miss["source_id"] is None
    empty = gaia.match_label(result, stacks, 45.0, 10.0, epoch=1)  # blank sky
    assert empty["label"] == "unmeasured"


def test_masked_core_is_unmeasured_not_unmatched():
    w, stacks, cat, injected = synthetic_view()
    x, y = (round(v) for v in injected[0])
    stacks[0][y - 1 : y + 2, x - 1 : x + 2] = np.nan  # saturated core, masked by the pipeline
    result = gaia.overlay(cat, EPOCHS_MJD, stacks, w)
    barnard = next(s for s in result["stars"] if s["source_id"] == B.source_id)
    assert barnard["matched"] == [False, True, True]
    assert gaia.match_label(result, stacks, *injected[0], epoch=0)["label"] == "unmeasured"


def test_off_grid_stars_are_left_out_and_brightest_kept_first():
    w, stacks, cat, _ = synthetic_view()
    far = catalog([(7, CENTER[0] + 0.2, CENTER[1], 0.0, 0.0, 1.0, np.nan, 10.0)])  # 12' away: off a 6' grid
    result = gaia.overlay(np.concatenate([cat, far]), EPOCHS_MJD, stacks, w)
    ids = [s["source_id"] for s in result["stars"]]
    assert 7 not in ids and ids[0] == B.source_id  # sorted by G, Barnard's (8.2) first


def test_demo_catalogue_rows_have_no_source_ids():
    cat = gaia.catalog_from_rows(align.load_gaia_csv(config.DEMO_DIR / "barnard" / "gaia.csv"))
    assert len(cat) > 100 and np.isnan(cat["radial_velocity"]).all()
    assert (cat["source_id"] == gaia.UNKNOWN_SOURCE_ID).all()
    w, shape = grid()
    result = gaia.overlay(cat, EPOCHS_MJD, [np.zeros(shape)] * 3, w)
    assert result["stars"] and all(s["source_id"] is None for s in result["stars"])
    assert len(gaia.catalog_from_rows([])) == 0


def test_gaia_down_means_no_catalogue_not_an_error(monkeypatch):
    def down(*a, **k):
        raise gaia.GaiaUnavailable("ESA: timeout; ARI: timeout")

    monkeypatch.setattr(gaia, "query_gaia_cone", down)
    assert gaia.live_catalog(*CENTER, 6) is None


def wait_ready(client, view_id, timeout=90):
    deadline = time.time() + timeout
    while (body := client.get(f"/api/views/{view_id}").json())["status"] not in ("ready", "error"):
        assert time.time() < deadline, "view did not finish"
        time.sleep(0.2)
    assert body["status"] == "ready", body
    return body


def test_gaia_endpoint_on_the_barnard_demo_view():
    client = TestClient(app)
    r = client.post("/api/views", json={"ra": CENTER[0], "dec": CENTER[1], "fov_arcmin": 6, "band": "B1-B2"})
    view_id = r.json()["view_id"]
    body = wait_ready(client, view_id)
    m = client.get(body["manifest_url"]).json()
    assert m["extras"]["gaia"] == "gaia.json"
    assert client.get(body["manifest_url"].replace("manifest.json", "gaia.json")).status_code == 200

    g = client.get(f"/api/views/{view_id}/gaia").json()
    n_epochs = len(m["epochs"])
    assert g["epochs_mjd"] == [e["t_mean_mjd"] for e in m["epochs"]] and g["selection"] is None
    assert g["stars"] and all(len(s["track_px"]) == len(s["matched"]) == n_epochs for s in g["stars"])
    assert sum(any(s["matched"]) for s in g["stars"]) >= 5  # real field stars are found where Gaia says
    # Barnard's Star itself (G 8.2, brightest in the field) moves north between the passes.
    star = min(g["stars"], key=lambda s: s["g"] if s["g"] is not None else 99)
    assert star["track_px"][-1][1] - star["track_px"][0][1] > 1.0

    nx = m["grid"]["nx"]
    sel = client.get(f"/api/views/{view_id}/gaia", params={"x": nx // 2, "y": nx // 2, "epoch": 0}).json()
    assert sel["selection"]["label"] in ("match", "no_match", "unmeasured")
    bad = client.get(f"/api/views/{view_id}/gaia", params={"x": 1, "y": 1, "epoch": 99})
    assert bad.status_code == 503 and bad.json()["error"]["code"] == "BAD_EPOCH"
    assert client.get("/api/views/nope/gaia").status_code == 404
