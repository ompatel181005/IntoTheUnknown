"""Gaia DR3 cone query and position propagation (PLAN §5.8).

Positions are astrometric, as seen from Earth at epoch t: space motion plus parallax,
with no aberration or light deflection. The SPHEREx WCS is tied to Gaia, so those are
already absorbed; `transform_to(GCRS)` would add ~20" of aberration (about 3 px).
"""

from __future__ import annotations

import contextvars
import io
import logging
import math
import os
import threading
import time
import warnings
from concurrent.futures import Future
from dataclasses import dataclass

import astropy.units as u
import numpy as np
import requests
from astropy.coordinates import (
    Distance,
    SkyCoord,
    UnitSphericalRepresentation,
    get_body_barycentric,
)
from astropy.io import votable
from astropy.time import Time
from erfa import ErfaWarning

from ..telemetry import operation

log = logging.getLogger(__name__)

GAIA_EPOCH = Time(2016.0, format="jyear", scale="tcb")

# --- Propagation ---------------------------------------------------------------------


def _as_float(x) -> np.ndarray:
    """None, masked or missing values become NaN."""
    if isinstance(x, np.ma.MaskedArray):
        return x.astype(float).filled(np.nan)
    return np.asarray(x, dtype=float)


def predict_radec_many(
    ra, dec, pmra, pmdec, plx, rv, t: Time, ref_epoch: Time = GAIA_EPOCH
) -> tuple[np.ndarray, np.ndarray]:
    """Vectorised `predict_radec`: arrays of stars (deg, mas/yr, mas, km/s), one epoch.

    - pmra or pmdec missing/non-finite: 2-parameter solution, returned unchanged.
    - parallax missing, non-finite or <= 0: proper motion only.
    - rv missing or non-finite: 0.
    """
    if not t.isscalar:
        raise ValueError("t must be a single Time")
    ra, dec, pmra, pmdec, plx, rv = np.broadcast_arrays(*(_as_float(v) for v in (ra, dec, pmra, pmdec, plx, rv)))
    out_ra, out_dec = ra.astype(float), dec.astype(float)  # copies; static by default

    has_pm = np.isfinite(pmra) & np.isfinite(pmdec)
    has_plx = has_pm & np.isfinite(plx) & (plx > 0)
    pm_only = has_pm & ~has_plx

    with warnings.catch_warnings():
        # With no (or a tiny) parallax ERFA substitutes a large distance and warns
        # "distance overridden". That is the behaviour we want, so keep logs quiet.
        warnings.simplefilter("ignore", ErfaWarning)
        if pm_only.any():
            m = pm_only
            out_ra[m], out_dec[m] = _pm_only(ra[m], dec[m], pmra[m], pmdec[m], t, ref_epoch)
        if has_plx.any():
            m = has_plx
            out_ra[m], out_dec[m] = _with_parallax(ra[m], dec[m], pmra[m], pmdec[m], plx[m], rv[m], t, ref_epoch)
    return out_ra, out_dec


def _pm_only(ra, dec, pmra, pmdec, t, ref_epoch):
    c = SkyCoord(
        ra=ra * u.deg,
        dec=dec * u.deg,
        pm_ra_cosdec=pmra * u.mas / u.yr,
        pm_dec=pmdec * u.mas / u.yr,
        obstime=ref_epoch,
        frame="icrs",
    )
    s = c.apply_space_motion(new_obstime=t)
    return s.ra.deg, s.dec.deg


def _with_parallax(ra, dec, pmra, pmdec, plx, rv, t, ref_epoch):
    c = SkyCoord(
        ra=ra * u.deg,
        dec=dec * u.deg,
        distance=Distance(parallax=plx * u.mas),
        pm_ra_cosdec=pmra * u.mas / u.yr,
        pm_dec=pmdec * u.mas / u.yr,
        radial_velocity=np.where(np.isfinite(rv), rv, 0.0) * u.km / u.s,
        obstime=ref_epoch,
        frame="icrs",
    )
    bary = c.apply_space_motion(new_obstime=t).cartesian.without_differentials()
    # Parallax by vector subtraction: star minus Earth, both barycentric (no GCRS).
    earth = get_body_barycentric("earth", t)
    geo = (bary - earth).represent_as(UnitSphericalRepresentation)
    return geo.lon.deg, geo.lat.deg


def predict_radec(ra, dec, pmra, pmdec, plx, rv, t: Time, ref_epoch: Time = GAIA_EPOCH) -> tuple[float, float]:
    """Astrometric (ra, dec) in deg of one star at epoch t. See `predict_radec_many`."""
    r, d = predict_radec_many(ra, dec, pmra, pmdec, plx, rv, t, ref_epoch)
    return float(r), float(d)


def propagate_catalog(cat: np.ndarray, t: Time) -> tuple[np.ndarray, np.ndarray]:
    """Propagate every row of a `query_gaia_cone` result to epoch t."""
    return predict_radec_many(
        cat["ra"],
        cat["dec"],
        cat["pmra"],
        cat["pmdec"],
        cat["parallax"],
        cat["radial_velocity"],
        t,
    )


# --- Cone query ----------------------------------------------------------------------

# PLAN §5.8 query. POINT/CIRCLE carry 'ICRS' because ARI's ADQL parser requires it
# (ESA accepts both forms).
GAIA_COLUMNS = (
    "source_id",
    "ra",
    "dec",
    "pmra",
    "pmdec",
    "parallax",
    "radial_velocity",
    "phot_g_mean_mag",
)
GAIA_DTYPE = np.dtype([("source_id", "i8")] + [(c, "f8") for c in GAIA_COLUMNS[1:]])
GAIA_CONE_ADQL = (
    "SELECT " + ", ".join(GAIA_COLUMNS) + " FROM gaiadr3.gaia_source "
    "WHERE 1=CONTAINS(POINT('ICRS',ra,dec), "
    "CIRCLE('ICRS',{ra:.8f},{dec:.8f},{r:.8f})) AND phot_g_mean_mag < 20.5"
)

# Tried in order. Both serve gaiadr3.gaia_source with identical columns and values.
GAIA_TAP_ENDPOINTS = (
    ("ESA", "https://gea.esac.esa.int/tap-server/tap/sync"),
    ("ARI", "https://gaia.ari.uni-heidelberg.de/tap/sync"),
)
# Sent as MAXREC. A truncated result is detected from the VOTable QUERY_STATUS=OVERFLOW
# (both servers set it, whoever's limit cut the result) or from reaching this length.
GAIA_MAX_ROWS = 50_000
MAX_RADIUS_DEG = 1.0


class GaiaUnavailable(RuntimeError):
    """The Gaia query could not return a complete result."""


class _EndpointError(Exception):
    """One endpoint failed; try the next."""


def cone_radius_deg(fov_arcmin: float) -> float:
    """Query radius covering the view's corners plus 2' for fast movers (PLAN §5.8)."""
    return (fov_arcmin * math.sqrt(2) / 2 + 2) / 60


def _timeout(timeout_s: float | None) -> float:
    if timeout_s is None:
        timeout_s = float(os.environ.get("GAIA_TIMEOUT_S", "30"))
    if not timeout_s > 0:
        raise ValueError(f"timeout must be > 0, got {timeout_s}")
    return timeout_s


def _parse_votable(body: bytes) -> tuple[np.ndarray, bool]:
    """TAP VOTable -> (rows as GAIA_DTYPE, overflow flag)."""
    try:
        vot = votable.parse(io.BytesIO(body), verify="ignore")
        infos = list(vot.infos) + [i for res in vot.resources for i in res.infos]
        status = [i.value for i in infos if i.name == "QUERY_STATUS"]
        if "ERROR" in status:
            msg = next(i.content for i in infos if i.value == "ERROR")
            raise _EndpointError(f"TAP error: {(msg or '').strip()[:300]}")
        # TAP 1.1: QUERY_STATUS=OK leads; a trailing OVERFLOW marks truncation.
        if not status or status[0] != "OK" or set(status) - {"OK", "OVERFLOW"}:
            raise _EndpointError(f"missing or unexpected QUERY_STATUS: {status}")
        tab = vot.get_first_table().to_table(use_names_over_ids=True)
    except _EndpointError:
        raise
    except Exception as e:  # anything unparseable is a bad response, not a crash
        raise _EndpointError(f"bad VOTable: {type(e).__name__}: {e}") from e
    if tuple(tab.colnames) != GAIA_COLUMNS:
        raise _EndpointError(f"unexpected columns: {tab.colnames}")
    ids = np.ma.asarray(tab["source_id"])
    if np.ma.is_masked(ids):
        raise _EndpointError("null source_id")
    out = np.empty(len(tab), dtype=GAIA_DTYPE)
    out["source_id"] = ids.filled(0)
    for c in GAIA_COLUMNS[1:]:
        out[c] = np.ma.asarray(tab[c], dtype=float).filled(np.nan)
    return out, "OVERFLOW" in status


def _fetch(url: str, adql: str, timeout_s: float, stop: threading.Event):
    data = {
        "REQUEST": "doQuery",
        "LANG": "ADQL",
        "FORMAT": "votable",
        "MAXREC": str(GAIA_MAX_ROWS),
        "QUERY": adql,
    }
    # (connect, read): a silent peer frees the worker after timeout_s. _fetch_within
    # bounds the caller's wait, however slowly a peer trickles bytes.
    timeout = (timeout_s, timeout_s)
    with requests.post(url, data=data, timeout=timeout, stream=True) as r:
        if r.status_code != 200:
            raise _EndpointError(f"HTTP {r.status_code}: {r.text[:300].strip()}")
        chunks = []
        for chunk in r.iter_content(chunk_size=1 << 16):
            if stop.is_set():
                raise _EndpointError("abandoned after the deadline")
            chunks.append(chunk)
    return _parse_votable(b"".join(chunks))


def _fetch_within(url: str, adql: str, timeout_s: float) -> tuple[np.ndarray, bool]:
    """Connect, download and parse in a worker; give up after timeout_s wall-clock.

    Each call gets its own daemon thread, so workers abandoned after a timeout never
    hold a shared pool or block interpreter exit. They stop at their next chunk.
    """
    stop = threading.Event()
    future: Future = Future()

    def run():
        try:
            future.set_result(_fetch(url, adql, timeout_s, stop))
        except Exception as e:
            future.set_exception(e)

    threading.Thread(target=contextvars.copy_context().run, args=(run,), name="gaia-tap", daemon=True).start()
    try:
        return future.result(timeout=timeout_s)
    except TimeoutError:
        stop.set()
        raise _EndpointError(f"no complete response within {timeout_s:g}s") from None


@operation("Gaia", "cone")
def query_gaia_cone(ra: float, dec: float, radius_deg: float, timeout_s: float | None = None) -> np.ndarray:
    """Gaia DR3 sources with G < 20.5 within radius_deg of (ra, dec), at J2016.0.

    Returns a structured array (`GAIA_DTYPE`), NaN where Gaia has no value. Tries ESA,
    then ARI. Each endpoint gets at most `timeout_s` of wall-clock time for connect,
    download and parse (env `GAIA_TIMEOUT_S`, default 30 s), so the call returns or
    raises within about 2 x timeout_s. Raises `GaiaUnavailable` unless a complete,
    untruncated result comes back.
    """
    ra, dec, radius_deg = float(ra) % 360.0, float(dec), float(radius_deg)
    if not (math.isfinite(ra) and -90 <= dec <= 90 and 0 < radius_deg <= MAX_RADIUS_DEG):
        raise ValueError(f"bad cone: ra={ra}, dec={dec}, radius_deg={radius_deg}")
    timeout_s = _timeout(timeout_s)
    adql = GAIA_CONE_ADQL.format(ra=ra, dec=dec, r=radius_deg)

    errors = []
    for name, url in GAIA_TAP_ENDPOINTS:
        t0 = time.monotonic()
        try:
            cat, overflow = _fetch_within(url, adql, timeout_s)
            if len(cat) >= GAIA_MAX_ROWS:
                raise GaiaUnavailable(
                    f"{GAIA_MAX_ROWS} or more Gaia sources in r={radius_deg:.3f} deg; use a smaller field of view"
                )
            if overflow:  # the server's own limit, below ours: another may do better
                raise _EndpointError(f"server truncated the result at {len(cat)} rows")
        except (OSError, _EndpointError) as e:  # requests' exceptions are OSErrors
            errors.append(f"{name}: {type(e).__name__}: {e}")
            log.warning("Gaia %s failed after %.1fs: %s", name, time.monotonic() - t0, e)
            continue
        log.info("Gaia %s: %d rows in %.1fs", name, len(cat), time.monotonic() - t0)
        return cat
    raise GaiaUnavailable("Gaia DR3 query failed on every endpoint: " + "; ".join(errors))


# --- Presets -------------------------------------------------------------------------


@dataclass(frozen=True)
class PresetAstrometry:
    ra: float  # deg, at ref_epoch
    dec: float
    pmra: float  # mas/yr, pm_ra * cos(dec)
    pmdec: float
    parallax: float  # mas
    radial_velocity: float  # km/s, NaN if unknown
    ref_epoch: Time = GAIA_EPOCH  # epoch of ra, dec
    source_id: int | None = None  # Gaia DR3, None if not in Gaia


# WISE 0855-0714 is not in Gaia. Position: CatWISE2020 (IRSA table catwise_2020),
# source J085507.96-071439.3, ra_pm/dec_pm at epoch MJD 57170 (2015.405) per
# https://irsa.ipac.caltech.edu/data/WISE/CatWISE/gator_docs/catwise_colDescriptions.html
# CatWISE splits this fast mover into several entries; this one has the smallest pm
# errors. Its pm (-8021, +1036 mas/yr) misses the AllWISE 2010.59 position by 1.9",
# so pm stays the literature (-8120, +680), which lands 0.4" from it. Parallax ~439 mas
# is literature too (we believe Kirkpatrick et al. 2021, ApJS 253, 7; unconfirmed).
_CATWISE_EPOCH = Time(57170.0, format="mjd", scale="tdb")

# Gaia DR3 at J2016.0 (docs/TARGETS.md), full precision from the ESA TAP on 2026-11-14.
PRESETS: dict[str, PresetAstrometry] = {
    "barnard": PresetAstrometry(
        ra=269.448502525,
        dec=4.739420051,
        pmra=-801.551,
        pmdec=10362.394,
        parallax=546.976,
        radial_velocity=-110.468,
        source_id=4472832130942575872,
    ),
    "eps_ind_b": PresetAstrometry(
        ra=331.076452597,
        dec=-56.793812062,
        pmra=3981.977,
        pmdec=-2466.832,
        parallax=270.658,
        radial_velocity=np.nan,
        source_id=6412596012146801152,
    ),
    "wise0855": PresetAstrometry(
        ra=133.783924,
        dec=-7.2443404,
        pmra=-8120.0,
        pmdec=680.0,
        parallax=439.0,
        radial_velocity=np.nan,
        ref_epoch=_CATWISE_EPOCH,
    ),
    "rw_aur": PresetAstrometry(
        ra=76.956081196,
        dec=30.401204589,
        pmra=2.641,
        pmdec=-27.398,
        parallax=6.406,
        radial_velocity=-20.937,
        source_id=156430822114424576,
    ),
    "r_dra": PresetAstrometry(
        ra=248.167378367,
        dec=66.755006745,
        pmra=-20.643,
        pmdec=6.149,
        parallax=1.251,
        radial_velocity=np.nan,
        source_id=1648328016354496384,
    ),
}


def preset_centre(target_id: str, t: Time) -> tuple[float, float]:
    """(ra, dec) in deg of a preset target at epoch t, parallax included."""
    if target_id not in PRESETS:
        raise KeyError(f"unknown target {target_id!r}; known: {sorted(PRESETS)}")
    p = PRESETS[target_id]
    return predict_radec(p.ra, p.dec, p.pmra, p.pmdec, p.parallax, p.radial_velocity, t, p.ref_epoch)


# --- Overlay (issue #29, PLAN §5.8) --------------------------------------------------
# For a rendered view: where every Gaia star should be in each epoch (grid pixels, FITS
# orientation, 0-based), and whether a source was measured there. A mover Gaia can't
# explain is a source with no track nearby.

MATCH_PX = 1.0  # PLAN §5.8: a centroid within 1.0 px of a track is a "Gaia match"
MATCH_MIN_SNR = 5.0  # a peak fainter than this is "not measured", never "no match"
MAX_OVERLAY_STARS = 600  # brightest first; a 15' field near the plane can hold thousands
UNKNOWN_SOURCE_ID = -1  # demo-pack catalogues (VizieR) carry no source_id


def catalog_from_rows(rows: list[dict]) -> np.ndarray:
    """Demo-pack catalogue rows (align.load_gaia_csv: VizieR I/355 at J2016.0) as GAIA_DTYPE.

    VizieR's export has no source_id or radial velocity: source_id is UNKNOWN_SOURCE_ID and
    rv is NaN (proper motion and parallax still apply). Rows without a position are dropped.
    """
    cat = np.empty(len(rows), GAIA_DTYPE)
    for i, r in enumerate(rows):
        cat[i] = (UNKNOWN_SOURCE_ID, r["ra"], r["dec"], r["pmra"], r["pmdec"], r["plx"], np.nan, r["gmag"])
    return cat[np.isfinite(cat["ra"]) & np.isfinite(cat["dec"])]


def live_catalog(ra: float, dec: float, fov_arcmin: float) -> np.ndarray | None:
    """Gaia DR3 around a live view, or None when every endpoint fails (the overlay is then left out)."""
    try:
        return query_gaia_cone(ra, dec, cone_radius_deg(fov_arcmin))
    except (GaiaUnavailable, ValueError) as e:
        log.warning("Gaia overlay skipped: %s", e)
        return None


def _robust_sigma(img: np.ndarray) -> float:
    v = img[np.isfinite(img)]
    if v.size < 50:
        return float("nan")
    return float(1.4826 * np.median(np.abs(v - np.median(v))))


def centroid_near(img: np.ndarray, x: float, y: float, sigma: float, search_px: float = 1.5) -> tuple | None:
    """Centroid of the brightest peak within search_px of (x, y), or None if nothing measurable.

    Flux-weighted over the 3x3 box around the peak, after subtracting the median of a 7x7
    border. None when the box touches a masked pixel or the peak is under MATCH_MIN_SNR.
    """
    ny, nx = img.shape
    r = int(np.ceil(search_px))
    cx, cy = int(np.rint(x)), int(np.rint(y))
    if not (r + 3 <= cx < nx - r - 3 and r + 3 <= cy < ny - r - 3) or not sigma > 0:
        return None
    yy, xx = np.mgrid[cy - r : cy + r + 1, cx - r : cx + r + 1]
    sub = img[cy - r : cy + r + 1, cx - r : cx + r + 1]
    inside = (np.hypot(xx - x, yy - y) <= search_px) & np.isfinite(sub)
    if not inside.any():
        return None
    k = np.argmax(np.where(inside, sub, -np.inf))
    py, px = int(yy.flat[k]), int(xx.flat[k])
    win = img[py - 3 : py + 4, px - 3 : px + 4]
    border = np.concatenate([win[0], win[-1], win[1:-1, 0], win[1:-1, -1]])
    border = border[np.isfinite(border)]
    box = img[py - 1 : py + 2, px - 1 : px + 2]
    if border.size < 8 or not np.isfinite(box).all():
        return None
    w = box - float(np.median(border))
    if not w[1, 1] > MATCH_MIN_SNR * sigma:
        return None
    w = np.clip(w, 0, None)
    oy, ox = np.mgrid[-1:2, -1:2]
    return float(px + (w * ox).sum() / w.sum()), float(py + (w * oy).sum() / w.sum())


def tracks(cat: np.ndarray, epochs_mjd: list[float], grid_wcs, shape: tuple[int, int]) -> tuple[np.ndarray, np.ndarray]:
    """Predicted (n_stars, n_epochs, 2) pixel tracks for the stars that land on the grid, and their indices."""
    if len(cat) == 0 or not epochs_mjd:
        return np.empty((0, len(epochs_mjd), 2)), np.empty(0, int)
    xy = np.empty((len(cat), len(epochs_mjd), 2))
    for e, mjd in enumerate(epochs_mjd):
        ra, dec = propagate_catalog(cat, Time(mjd, format="mjd", scale="tdb"))
        xy[:, e, 0], xy[:, e, 1] = grid_wcs.world_to_pixel(SkyCoord(ra, dec, unit="deg"))
    ny, nx = shape
    on = ((xy[..., 0] >= -0.5) & (xy[..., 0] < nx - 0.5) & (xy[..., 1] >= -0.5) & (xy[..., 1] < ny - 0.5)).any(1)
    idx = np.flatnonzero(on)
    g = np.where(np.isfinite(cat["phot_g_mean_mag"][idx]), cat["phot_g_mean_mag"][idx], 99.0)
    idx = idx[np.argsort(g, kind="stable")][:MAX_OVERLAY_STARS]
    return xy[idx], idx


def overlay(cat: np.ndarray, epochs_mjd: list[float], stacks: list[np.ndarray], grid_wcs) -> dict:
    """The /api/views/{id}/gaia body (PLAN §4.3): per-star pixel tracks and per-epoch matches."""
    shape = stacks[0].shape if stacks else (0, 0)
    xy, idx = tracks(cat, epochs_mjd, grid_wcs, shape)
    sigmas = [_robust_sigma(s) for s in stacks]

    def val(v):
        return None if not np.isfinite(v) else round(float(v), 3)

    stars = []
    for k, i in enumerate(idx):
        matched = []
        for e, img in enumerate(stacks):
            c = centroid_near(img, *xy[k, e], sigmas[e])
            matched.append(c is not None and math.hypot(c[0] - xy[k, e, 0], c[1] - xy[k, e, 1]) <= MATCH_PX)
        sid = int(cat["source_id"][i])
        stars.append(
            {
                "source_id": None if sid == UNKNOWN_SOURCE_ID else sid,
                "g": val(cat["phot_g_mean_mag"][i]),
                "pmra": val(cat["pmra"][i]),
                "pmdec": val(cat["pmdec"][i]),
                "plx": val(cat["parallax"][i]),
                "track_px": [[round(float(px), 3), round(float(py), 3)] for px, py in xy[k]],
                "matched": matched,
            }
        )
    return {"epochs_mjd": [float(m) for m in epochs_mjd], "stars": stars, "unexplained": []}


def match_label(result: dict, stacks: list[np.ndarray], x: float, y: float, epoch: int) -> dict:
    """ "Gaia match" label for the source at grid pixel (x, y) in one epoch (PLAN §5.8).

    match: its centroid is within MATCH_PX of a Gaia track in that epoch.
    no_match: a source was measured there but no track is within MATCH_PX.
    unmeasured: no peak above MATCH_MIN_SNR, or masked pixels (saturated cores).
    """
    if not (0 <= epoch < len(stacks)):
        raise ValueError(f"epoch {epoch} out of range 0..{len(stacks) - 1}")
    img = stacks[epoch]
    c = centroid_near(img, x, y, _robust_sigma(img), search_px=2.0)
    out = {"epoch": epoch, "centroid_px": None, "label": "unmeasured", "source_id": None, "sep_px": None}
    if c is None:
        return out
    out["centroid_px"] = [round(c[0], 3), round(c[1], 3)]
    best, best_d = None, math.inf
    for s in result["stars"]:
        tx, ty = s["track_px"][epoch]
        d = math.hypot(c[0] - tx, c[1] - ty)
        if d < best_d:
            best, best_d = s, d
    if best is not None and best_d <= MATCH_PX:
        out.update(label="match", source_id=best["source_id"], sep_px=round(best_d, 3))
    else:
        out.update(label="no_match", sep_px=None if best is None else round(best_d, 3))
    return out
