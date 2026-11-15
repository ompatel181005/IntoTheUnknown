"""Offline tests for app.processing.gaia, ported from docs/skeletons/check.py.

No network: IERS downloads are off and every HTTP call is mocked.
"""

import threading
import time

import numpy as np
import pytest
import requests
from astropy.coordinates import SkyCoord
from astropy.time import Time
from astropy.utils import iers
from astropy.utils.data import conf as data_conf

from app.processing import gaia

T2026 = Time(2026.0, format="jyear", scale="tcb")
BARNARD = (269.448503, 4.739420, -801.55, 10362.39)  # Gaia DR3 at J2016.0, TARGETS.md
BARNARD_PLX = 546.98


@pytest.fixture(autouse=True, scope="module")
def _offline():
    with (
        iers.conf.set_temp("auto_download", False),
        data_conf.set_temp("allow_internet", False),
    ):
        yield


def sep_arcsec(a, b) -> float:
    return SkyCoord(*a, unit="deg").separation(SkyCoord(*b, unit="deg")).arcsec


# --- Propagation ---------------------------------------------------------------------


def test_barnard_2026_by_proper_motion_alone():
    got = gaia.predict_radec(*BARNARD, None, None, T2026)
    assert sep_arcsec(got, (269.44627, 4.76820)) < 1.0


def test_barnard_parallax_term_nonzero_and_bounded():
    pm_only = gaia.predict_radec(*BARNARD, None, None, T2026)
    full = gaia.predict_radec(*BARNARD, BARNARD_PLX, None, T2026)
    assert 0.05 < sep_arcsec(full, pm_only) <= 0.55


@pytest.mark.parametrize("plx", [None, np.nan, 0.0, -1.2])
def test_bad_parallax_means_proper_motion_only(plx):
    expected = gaia.predict_radec(*BARNARD, None, None, T2026)
    assert gaia.predict_radec(*BARNARD, plx, 10.0, T2026) == expected


@pytest.mark.filterwarnings("error")
def test_tiny_parallax_is_quiet_and_matches_pm_only():
    tiny = gaia.predict_radec(10.0, 20.0, 5.0, 5.0, 1e-6, np.nan, T2026)
    pm_only = gaia.predict_radec(10.0, 20.0, 5.0, 5.0, None, None, T2026)
    assert sep_arcsec(tiny, pm_only) < 1e-3


@pytest.mark.parametrize("pmra, pmdec", [(np.nan, np.nan), (None, None), (np.nan, 5.0)])
def test_missing_proper_motion_is_static(pmra, pmdec):
    got = gaia.predict_radec(10.0, 20.0, pmra, pmdec, 1.5, np.nan, T2026)
    assert got == (10.0, 20.0)


def test_nan_radial_velocity_is_zero():
    nan_rv = gaia.predict_radec(*BARNARD, BARNARD_PLX, np.nan, T2026)
    zero_rv = gaia.predict_radec(*BARNARD, BARNARD_PLX, 0.0, T2026)
    assert nan_rv == zero_rv


def test_vectorised_matches_scalar():
    stars = [
        (*BARNARD, BARNARD_PLX, -110.47),  # parallax + rv
        (*BARNARD, None, None),  # pm only
        (10.0, 20.0, np.nan, np.nan, np.nan, np.nan),  # 2-parameter: static
        (331.076453, -56.793812, 3982.0, -2466.8, 270.7, np.nan),  # parallax, no rv
        (359.9999, 0.0, 50.0, 0.0, -0.5, 10.0),  # negative parallax, crosses RA 0
    ]
    cols = [np.array([s[i] for s in stars], dtype=float) for i in range(6)]
    ra, dec = gaia.predict_radec_many(*cols, T2026)
    for i, star in enumerate(stars):
        r1, d1 = gaia.predict_radec(*star, T2026)
        assert ra[i] == pytest.approx(r1, abs=1e-10)
        assert dec[i] == pytest.approx(d1, abs=1e-10)
    assert ra[4] < 1.0  # wrapped into [0, 360)


# --- Presets -------------------------------------------------------------------------

# docs/TARGETS.md centring table at 2026.0 (pm only; preset_centre adds <= 0.55").
TARGETS_2026 = {
    "barnard": (269.44627, 4.76820),
    "eps_ind_b": (331.09665, -56.80066),
    "rw_aur": (76.95608, 30.40113),
    "r_dra": (248.16723, 66.75502),
}


def test_presets_cover_all_five_targets():
    assert set(gaia.PRESETS) == set(TARGETS_2026) | {"wise0855"}


@pytest.mark.parametrize("target, expected", TARGETS_2026.items())
def test_preset_centre_matches_targets_md(target, expected):
    assert sep_arcsec(gaia.preset_centre(target, T2026), expected) < 1.0


# WISE 0855 catalogue measurements (IRSA, 2026-11-14). preset_centre includes the
# 0.44" parallax; the catalogue fits average over it, hence the tolerances.
CATWISE_0855 = (133.783924, -7.2443404)  # J085507.96-071439.3 ra_pm, dec_pm
CATWISE_EPOCH = Time(57170.0, format="mjd", scale="tdb")
ALLWISE_0855 = (133.7947597, -7.2451456)  # J085510.74-071442.5 ra, dec
ALLWISE_EPOCH = Time(55412.32635051, format="mjd", scale="tdb")  # w2mjdmean


def test_preset_centre_wise0855_matches_catwise_at_its_epoch():
    got = gaia.preset_centre("wise0855", CATWISE_EPOCH)
    assert sep_arcsec(got, CATWISE_0855) < 0.6


def test_preset_centre_wise0855_matches_independent_allwise_epoch():
    # 4.8 yr earlier: checks the proper motion, not just the anchor position.
    got = gaia.preset_centre("wise0855", ALLWISE_EPOCH)
    assert sep_arcsec(got, ALLWISE_0855) < 1.0


def test_preset_centre_moves_with_epoch():
    a = gaia.preset_centre("barnard", Time(2025.5, format="jyear", scale="tcb"))
    b = gaia.preset_centre("barnard", Time(2026.5, format="jyear", scale="tcb"))
    assert 9.5 < sep_arcsec(a, b) < 11.5  # ~10.4"/yr, +-0.55" parallax


def test_preset_centre_unknown_target():
    with pytest.raises(KeyError):
        gaia.preset_centre("planet_x", T2026)


def test_cone_radius():
    assert gaia.cone_radius_deg(6) == pytest.approx((6 * 2**0.5 / 2 + 2) / 60)


# --- Cone query (mocked HTTP) --------------------------------------------------------

ROWS = [
    ("4472832130942575872", "269.4485025", "4.7394201", "-801.55", "10362.39", "546.98",
     "-110.47", "8.19"),
    ("4472808869388202880", "269.3849161", "4.6956692", "-4.537", "-5.644", "0.310", "",
     "20.18"),
    ("4472811824325764992", "269.3704051", "4.7068290", "", "", "", "", "20.41"),
]  # fmt: skip
TYPES = {"source_id": "long", "radial_velocity": "float", "phot_g_mean_mag": "float"}


def votable(rows=ROWS, status_after=None, columns=gaia.GAIA_COLUMNS, status="OK") -> str:
    """A TAP result like ESA's and ARI's; status_after mimics the trailing INFO."""
    fields = "".join(f'<FIELD name="{c}" datatype="{TYPES.get(c, "double")}"/>' for c in columns)
    trs = "".join("<TR>" + "".join(f"<TD>{v}</TD>" for v in r) + "</TR>" for r in rows)
    post = f'<INFO name="QUERY_STATUS" value="{status_after}"/>' if status_after else ""
    pre = f'<INFO name="QUERY_STATUS" value="{status}"/>' if status else ""
    return (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<VOTABLE version="1.4" xmlns="http://www.ivoa.net/xml/VOTable/v1.3">'
        f'<RESOURCE type="results">{pre}'
        f"<TABLE>{fields}<DATA><TABLEDATA>{trs}</TABLEDATA></DATA></TABLE>{post}"
        "</RESOURCE></VOTABLE>"
    )


TAP_ERROR = (
    '<?xml version="1.0" encoding="UTF-8"?>'
    '<VOTABLE version="1.4" xmlns="http://www.ivoa.net/xml/VOTable/v1.3">'
    '<RESOURCE type="results"><INFO name="QUERY_STATUS" value="ERROR">'
    "Incorrect ADQL query</INFO></RESOURCE></VOTABLE>"
)


class FakeResponse:
    def __init__(self, body: str, status=200, delay_s=0.0, stall=None):
        self.status_code = status
        self.text = body
        self._body = body.encode()
        self._delay_s = delay_s
        self._stall = stall  # threading.Event: a read that blocks until it is set

    def iter_content(self, chunk_size=1):
        for i in range(0, len(self._body), 64):
            if self._stall is not None and i:
                self._stall.wait(5)
            time.sleep(self._delay_s)
            yield self._body[i : i + 64]

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def fake_post(monkeypatch, *outcomes):
    """Each call to requests.post consumes the next outcome (response or exception)."""
    calls = []

    def post(url, **kwargs):
        calls.append((url, kwargs))
        out = outcomes[len(calls) - 1]
        if isinstance(out, Exception):
            raise out
        return out

    monkeypatch.setattr(gaia.requests, "post", post)
    return calls


def query(timeout_s=5):
    return gaia.query_gaia_cone(269.44627, 4.76820, 0.1, timeout_s=timeout_s)


def test_query_parses_votable_with_nan_for_missing(monkeypatch):
    monkeypatch.setenv("GAIA_TIMEOUT_S", "7")
    calls = fake_post(monkeypatch, FakeResponse(votable()))
    cat = gaia.query_gaia_cone(269.44627, 4.76820, 0.1)

    assert len(calls) == 1 and calls[0][0] == gaia.GAIA_TAP_ENDPOINTS[0][1]
    assert calls[0][1]["timeout"] == (7.0, 7.0)  # (connect, read)
    data = calls[0][1]["data"]
    assert data["FORMAT"] == "votable" and data["MAXREC"] == str(gaia.GAIA_MAX_ROWS)
    assert "FROM gaiadr3.gaia_source" in data["QUERY"]
    assert "phot_g_mean_mag < 20.5" in data["QUERY"]
    assert "CIRCLE('ICRS',269.44627000,4.76820000,0.10000000)" in data["QUERY"]

    assert cat.dtype == gaia.GAIA_DTYPE and len(cat) == 3
    assert cat["source_id"][0] == 4472832130942575872
    assert np.isnan(cat["radial_velocity"][1])
    assert np.isnan(cat["pmra"][2]) and np.isnan(cat["parallax"][2])

    ra, dec = gaia.propagate_catalog(cat, T2026)
    assert sep_arcsec((ra[0], dec[0]), gaia.preset_centre("barnard", T2026)) < 0.01
    assert (ra[2], dec[2]) == (cat["ra"][2], cat["dec"][2])  # 2-parameter: static


def test_query_falls_back_to_ari(monkeypatch):
    ok = FakeResponse(votable())
    calls = fake_post(monkeypatch, requests.ConnectionError("reset"), ok)
    assert len(query()) == 3
    assert [c[0] for c in calls] == [url for _, url in gaia.GAIA_TAP_ENDPOINTS]


@pytest.mark.parametrize("exc", [requests.Timeout, requests.ConnectionError])
def test_query_network_failure_raises_gaia_unavailable(monkeypatch, exc):
    fake_post(monkeypatch, exc("boom"), exc("boom"))
    with pytest.raises(gaia.GaiaUnavailable, match="ESA.*ARI"):
        query()


def test_query_never_returns_garbage(monkeypatch):
    fake_post(monkeypatch, FakeResponse("<html>oops</html>"), FakeResponse("busy", 503))
    with pytest.raises(gaia.GaiaUnavailable, match="ESA.*bad VOTable.*ARI.*HTTP 503"):
        query()


def test_query_rejects_wrong_columns_and_tap_errors(monkeypatch):
    short = votable(rows=[r[:7] for r in ROWS], columns=gaia.GAIA_COLUMNS[:7])
    fake_post(monkeypatch, FakeResponse(short), FakeResponse(TAP_ERROR))
    with pytest.raises(gaia.GaiaUnavailable, match="unexpected columns.*TAP error"):
        query()


def test_query_server_overflow_tries_next_endpoint(monkeypatch):
    # A server cutting the result below our MAXREC must never be accepted.
    capped = FakeResponse(votable(rows=ROWS[:2], status_after="OVERFLOW"))
    calls = fake_post(monkeypatch, capped, FakeResponse(votable()))
    assert len(query()) == 3 and len(calls) == 2


def test_query_server_overflow_everywhere_raises(monkeypatch):
    capped = FakeResponse(votable(rows=ROWS[:2], status_after="OVERFLOW"))
    fake_post(monkeypatch, capped, capped)
    with pytest.raises(gaia.GaiaUnavailable, match="truncated the result at 2 rows"):
        query()


@pytest.mark.parametrize("status_after", ["OVERFLOW", None])
def test_query_reaching_our_cap_raises(monkeypatch, status_after):
    monkeypatch.setattr(gaia, "GAIA_MAX_ROWS", 3)
    calls = fake_post(monkeypatch, FakeResponse(votable(status_after=status_after)))
    with pytest.raises(gaia.GaiaUnavailable, match="smaller field of view"):
        query()
    assert len(calls) == 1 and calls[0][1]["data"]["MAXREC"] == "3"


def test_query_slow_download_hits_deadline(monkeypatch):
    slow = FakeResponse(votable(), delay_s=0.03)  # ~20 chunks, ~0.6 s
    fake_post(monkeypatch, slow, slow)
    with pytest.raises(gaia.GaiaUnavailable, match="no complete response within"):
        query(timeout_s=0.05)


def test_query_stalled_read_is_bounded(monkeypatch):
    release = threading.Event()
    stalled = FakeResponse(votable(), stall=release)
    fake_post(monkeypatch, stalled, stalled)
    t0 = time.monotonic()
    try:
        with pytest.raises(gaia.GaiaUnavailable, match="no complete response within"):
            query(timeout_s=0.2)
        assert time.monotonic() - t0 < 1.0  # 2 endpoints x 0.2 s, plus slack
    finally:
        release.set()


def test_repeated_timeouts_do_not_starve_later_queries(monkeypatch):
    # 20 abandoned workers (more than any small pool) must not delay the next query.
    release = threading.Event()
    stalled = FakeResponse(votable(), stall=release)
    fake_post(monkeypatch, *([stalled] * 20), FakeResponse(votable()))
    try:
        for _ in range(10):
            with pytest.raises(gaia.GaiaUnavailable):
                query(timeout_s=0.05)
        t0 = time.monotonic()
        assert len(query(timeout_s=1.0)) == 3
        assert time.monotonic() - t0 < 0.5
    finally:
        release.set()


@pytest.mark.parametrize("status", [None, "UNKNOWN"])
def test_query_requires_query_status_ok(monkeypatch, status):
    calls = fake_post(monkeypatch, FakeResponse(votable(status=status)), FakeResponse(votable()))
    assert len(query()) == 3 and len(calls) == 2  # first endpoint rejected


def test_query_without_query_status_everywhere_raises(monkeypatch):
    bad = FakeResponse(votable(status=None))
    fake_post(monkeypatch, bad, bad)
    with pytest.raises(gaia.GaiaUnavailable, match="missing or unexpected QUERY_STATUS"):
        query()


@pytest.mark.parametrize("ra, dec, r", [(10, 95, 0.1), (np.nan, 0, 0.1), (10, 0, 0)])
def test_query_rejects_bad_cone(ra, dec, r):
    with pytest.raises(ValueError):
        gaia.query_gaia_cone(ra, dec, r, timeout_s=5)
