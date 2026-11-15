"""Alignment check against Gaia field stars (docs/PLAN.md 5.4, issue #15).

Each epoch stack is compared with where Gaia says its field stars should be. A mean offset over MAX_OFFSET_PX
moves that epoch's grid (CRPIX) and re-reprojects its frames. The per-axis centroid scatter is `astrom_resid_px`.
"""

import csv
import logging
from pathlib import Path

import numpy as np
from astropy.stats import sigma_clipped_stats
from astropy.wcs import WCS
from scipy.optimize import least_squares  # installed with reproject

from . import stack

log = logging.getLogger(__name__)

GAIA_EPOCH = 2016.0  # Gaia DR3 reference epoch of the catalogue positions
MAX_OFFSET_PX = 0.15  # PLAN 5.4: above this the epoch is re-reprojected
MIN_STARS = 4
MAX_PM_MASYR = 100.0  # "non-high-PM": faster stars are the targets, not the reference frame
MAX_PLX_MAS = 20.0  # parallax is ignored, so keep it under 0.004 px
MAX_GMAG = 16.5  # fainter stars are too noisy in 6.15 arcsec pixels
ISOLATION_PX = 3.0  # no comparable neighbour (within 2.5 mag) this close
MIN_SNR = 10.0
HALF = 3  # centroid window is 7 x 7 px
MAX_MATCH_PX = 1.0  # a fit that lands further than this from the prediction is another source


def load_gaia_csv(path: Path) -> list[dict]:
    """Stars from a demo-pack gaia.csv (tools/fetch_demo.py). Missing or unreadable file gives []."""
    try:
        with open(path, newline="") as fh:
            rows = list(csv.DictReader(fh))
    except OSError:
        return []

    def num(v):
        try:
            return float(v)
        except (TypeError, ValueError):
            return np.nan

    return [
        {"ra": num(r.get("ra_icrs")), "dec": num(r.get("de_icrs")), "pmra": num(r.get("pmra")),
         "pmdec": num(r.get("pmde")), "plx": num(r.get("plx")), "gmag": num(r.get("gmag"))}
        for r in rows
    ]  # fmt: skip


def predict_px(stars: list[dict], w: WCS, t_mjd: float) -> np.ndarray:
    """(n, 2) grid pixel positions at t_mjd, by proper motion only (stars here are slow and distant)."""
    dt = 2000.0 + (t_mjd - 51544.5) / 365.25 - GAIA_EPOCH
    ra, dec, pmra, pmdec = (np.array([s[k] for s in stars], dtype=float) for k in ("ra", "dec", "pmra", "pmdec"))
    dec_t = dec + pmdec * dt / 3.6e6
    ra_t = ra + pmra * dt / 3.6e6 / np.cos(np.radians(dec))
    x, y = w.all_world2pix(ra_t, dec_t, 0)
    return np.column_stack([x, y])


def field_stars(stars: list[dict], w: WCS, shape: tuple[int, int], t_mjd: float) -> np.ndarray:
    """Predicted pixel positions of usable reference stars: slow, bright enough, isolated, inside the grid."""
    stars = [s for s in stars if np.isfinite([s["ra"], s["dec"], s["gmag"]]).all()]
    if not stars:
        return np.empty((0, 2))
    g = np.array([s["gmag"] for s in stars])
    pm = np.hypot([s["pmra"] for s in stars], [s["pmdec"] for s in stars])
    plx = np.array([s["plx"] for s in stars])
    xy = predict_px(
        [{**s, "pmra": np.nan_to_num(s["pmra"]), "pmdec": np.nan_to_num(s["pmdec"])} for s in stars], w, t_mjd
    )
    m = HALF + 1
    ok = (g <= MAX_GMAG) & (pm < MAX_PM_MASYR) & (plx < MAX_PLX_MAS)  # NaN pm or plx fails: unknown motion
    ok &= (xy[:, 0] >= m) & (xy[:, 0] < shape[1] - m) & (xy[:, 1] >= m) & (xy[:, 1] < shape[0] - m)
    keep = []
    for i in np.flatnonzero(ok):
        d = np.hypot(*(xy - xy[i]).T)
        d[i] = np.inf
        if not ((d < ISOLATION_PX) & (g < g[i] + 2.5)).any():
            keep.append(i)
    return xy[keep]


def centroid(img: np.ndarray, x: float, y: float, sigma: float) -> tuple[float, float] | None:
    """Gaussian-fit centroid in a 7 x 7 window; None when the window is masked, faint or the fit wanders off."""
    cx, cy = round(x), round(y)
    win = img[cy - HALF : cy + HALF + 1, cx - HALF : cx + HALF + 1]
    if win.shape != (2 * HALF + 1,) * 2 or not np.isfinite(win).all():
        return None
    bkg = float(np.median(np.concatenate([win[0], win[-1], win[1:-1, 0], win[1:-1, -1]])))
    amp = float(win.max() - bkg)
    if not amp > MIN_SNR * sigma:
        return None
    yy, xx = np.mgrid[-HALF : HALF + 1, -HALF : HALF + 1]

    def resid(p):
        a, x0, y0, s, b = p
        return (a * np.exp(-((xx - x0) ** 2 + (yy - y0) ** 2) / (2 * s * s)) + b - win).ravel()

    try:
        fit = least_squares(
            resid,
            [amp, x - cx, y - cy, 1.0, bkg],
            bounds=([0, -HALF, -HALF, 0.3, -np.inf], [np.inf, HALF, HALF, HALF, np.inf]),
        )
    except ValueError:
        return None
    fx, fy = cx + fit.x[1], cy + fit.x[2]
    if not fit.success or np.hypot(fx - x, fy - y) > MAX_MATCH_PX:
        return None
    return float(fx), float(fy)


def measure(img: np.ndarray, pred: np.ndarray) -> dict | None:
    """Offset (measured - predicted) and scatter of one stack against predicted star positions, or None."""
    finite = img[np.isfinite(img)]
    if finite.size < 50 or len(pred) < MIN_STARS:
        return None
    _, _, sigma = sigma_clipped_stats(finite, sigma=3)
    d = np.array([(c[0] - x, c[1] - y) for x, y in pred if (c := centroid(img, x, y, float(sigma))) is not None])
    if len(d) < MIN_STARS:
        return None
    med = np.median(d, axis=0)
    mad = 1.4826 * np.median(np.abs(d - med), axis=0)
    d = d[(np.abs(d - med) <= np.maximum(3 * mad, 0.05)).all(axis=1)]  # drop blends and mismatches
    if len(d) < MIN_STARS:
        return None
    off = d.mean(axis=0)
    return {
        "dx": float(off[0]),
        "dy": float(off[1]),
        "resid_px": float(np.sqrt(np.mean(d.var(axis=0, ddof=1)))),  # per-axis centroid scatter (PLAN 5.8)
        "n_stars": len(d),
    }


def shifted(w: WCS, dx: float, dy: float) -> WCS:
    """Grid that cancels a measured (dx, dy) offset when a frame is reprojected onto it."""
    out = w.deepcopy()
    out.wcs.crpix = [w.wcs.crpix[0] - dx, w.wcs.crpix[1] - dy]
    return out


def align_epochs(epochs: list[list[dict]], w: WCS, shape: tuple[int, int], stars: list[dict]):
    """Stack the epochs, check each against Gaia and correct the ones that are off.

    Returns (stacks, info, astrom): stack.stack_epochs output plus one measure() dict or None per epoch.
    """
    stacks, info = stack.stack_epochs(epochs, w, shape)
    if not stars:
        return stacks, info, [None] * len(epochs)
    preds = [field_stars(stars, w, shape, float(np.mean([f["t_mjd"] for f in ep]))) for ep in epochs]
    astrom = [measure(s, p) for s, p in zip(stacks, preds)]
    bad = [i for i, a in enumerate(astrom) if a and np.hypot(a["dx"], a["dy"]) > MAX_OFFSET_PX]
    if bad:
        for i in bad:
            log.warning("epoch %d is off by (%.3f, %.3f) px; re-reprojecting", i, astrom[i]["dx"], astrom[i]["dy"])
            fixed = shifted(w, astrom[i]["dx"], astrom[i]["dy"])
            for f in epochs[i]:
                f["_grid"] = stack.to_grid(f, fixed, shape)
        stacks, info = stack.stack_epochs(epochs, w, shape)
        astrom = [measure(s, p) for s, p in zip(stacks, preds)]
    return stacks, info, astrom
