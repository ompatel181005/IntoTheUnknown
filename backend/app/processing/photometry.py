"""Forced aperture photometry and comparison-star scatter (docs/PLAN.md 5.9, issue #31).

Frames arrive here already cleaned: IMAGE - ZODI, flag-masked pixels set to NaN, residual sky subtracted, and
reprojected onto the view grid (`f["_grid"]`, see stack.to_grid).
"""

import warnings

import numpy as np
from astropy.coordinates import SkyCoord
from astropy.wcs import WCS

from . import stack

PIX_SR = (stack.PIX_ARCSEC / 206264.806) ** 2  # nominal pixel solid angle
UJY_PER_MJYSR_PIX = PIX_SR * 1e12  # MJy/sr x sr -> uJy
ANNULUS = (4.0, 7.0)  # background annulus, px
SATURATION = ("OVERFLOW", "NONLINEAR")  # kept for imaging, but photometry on these pixels is unreliable

MIN_COMP_STARS = 3
MAX_COMP_STARS = 6
COMP_MIN_SEP_PX = 6.0  # from the target and from each other
COMP_MIN_SNR = 10.0
MIN_DOF = 3  # residual degrees of freedom needed per comparison star


def aperture(im: np.ndarray, x: float, y: float, r_px: float = 2.0) -> dict | None:
    """Sum inside r_px minus the median of the 4-7 px annulus. None when the background can't be measured."""
    ny, nx = im.shape
    yy, xx = np.mgrid[0:ny, 0:nx]
    d = np.hypot(xx - x, yy - y)
    ap, ann = d <= r_px, (d >= ANNULUS[0]) & (d <= ANNULUS[1])
    bkg_px = im[ann & np.isfinite(im)]
    vals = im[ap]
    good = np.isfinite(vals)
    npix = int(good.sum())
    if bkg_px.size < 5 or npix == 0:
        return None
    bkg = float(np.median(bkg_px))
    sigma = float(np.std(bkg_px))
    return {
        "flux_ujy": (float(vals[good].sum()) - npix * bkg) * UJY_PER_MJYSR_PIX,
        "err_ujy": sigma * np.sqrt(npix) * UJY_PER_MJYSR_PIX,
        "n_masked": int(vals.size - npix),
    }


def saturated(f: dict, world: SkyCoord, r_px: float) -> bool:
    """True when OVERFLOW or NONLINEAR is set inside the aperture, checked on the frame's own pixels."""
    names = f.get("flag_names") or {}
    bits = sum(1 << names[n] for n in SATURATION if n in names)
    if not bits or f.get("flags") is None:
        return False
    w = f.get("_wcs")
    if w is None:
        w = f["_wcs"] = WCS(f["wcs_header"])
    fx, fy = w.world_to_pixel(world)
    flags = f["flags"]
    ny, nx = flags.shape
    r = int(np.ceil(r_px))
    cx, cy = round(float(fx)), round(float(fy))
    x0, x1 = max(cx - r, 0), min(cx + r + 1, nx)
    y0, y1 = max(cy - r, 0), min(cy + r + 1, ny)
    if x0 >= x1 or y0 >= y1:
        return False
    yy, xx = np.mgrid[y0:y1, x0:x1]
    inside = np.hypot(xx - float(fx), yy - float(fy)) <= r_px
    return bool(((flags[y0:y1, x0:x1][inside] & bits) != 0).any())


def measure(f: dict, x: float, y: float, r_px: float, world: SkyCoord | None = None) -> dict | None:
    """One light-curve point for frame f at grid position (x, y)."""
    res = aperture(f["_grid"][0], x, y, r_px)
    if res is None:
        return None
    flagged = res["n_masked"] > 0 or (world is not None and saturated(f, world, r_px))
    return {
        "t_mjd": f["t_mjd"],
        "lambda_um": f["lam_um"],
        "flux_ujy": res["flux_ujy"],
        "err": res["err_ujy"],
        "flagged": flagged,
    }


def _local_maxima(img: np.ndarray, size: int = 5) -> np.ndarray:
    """Boolean map of pixels that are the maximum of their size x size neighbourhood (NaN never wins)."""
    pad = size // 2
    filled = np.where(np.isfinite(img), img, -np.inf)
    padded = np.pad(filled, pad, constant_values=-np.inf)
    win = np.lib.stride_tricks.sliding_window_view(padded, (size, size))
    return np.isfinite(img) & (filled == win.max(axis=(-1, -2)))


def pick_comparison_stars(frames: list[dict], target_xy: tuple[float, float], r_px: float = 2.0) -> list[tuple]:
    """Up to 6 bright, unmasked, isolated field stars, brightest first, from the median of all frames."""
    if not frames:
        return []
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        med = np.nanmedian(np.array([f["_grid"][0] for f in frames]), axis=0)
    finite = med[np.isfinite(med)]
    if finite.size < 50:
        return []
    sky = float(np.median(finite))
    sig = 1.4826 * float(np.median(np.abs(finite - sky))) or float(np.std(finite))
    if not sig > 0:
        return []
    ny, nx = med.shape
    edge = ANNULUS[1] + 1
    peaks = np.argwhere(_local_maxima(med) & (med - sky > COMP_MIN_SNR * sig))
    cands = []
    for py, px in peaks:
        if not (edge <= px < nx - edge and edge <= py < ny - edge):
            continue
        if np.hypot(px - target_xy[0], py - target_xy[1]) < COMP_MIN_SEP_PX:
            continue
        res = aperture(med, float(px), float(py), r_px)
        if res is None or res["n_masked"]:
            continue
        cands.append((float(med[py, px]), float(px), float(py)))
    picked: list[tuple] = []
    for _, px, py in sorted(cands, reverse=True):
        if all(np.hypot(px - qx, py - qy) >= COMP_MIN_SEP_PX for qx, qy in picked):
            picked.append((px, py))
        if len(picked) == MAX_COMP_STARS:
            break
    return picked


def spectral_scatter(points: list[tuple[int, float, float]]) -> float | None:
    """Robust fractional scatter of one star's flux after removing its spectrum.

    points: (detector, lambda_um, flux_ujy). SPHEREx sees a star at a different wavelength in every frame, so raw
    flux differences mix spectrum and noise. Per detector, a low-order polynomial in ln(lambda) (quadratic when
    there are enough points) models the spectrum; the fractional residuals around it are calibration and photon
    noise. Residuals are scaled by sqrt(n / dof) so few points don't understate the scatter.
    """
    by_det: dict[int, list[tuple[float, float]]] = {}
    for det, lam, flux in points:
        by_det.setdefault(det, []).append((lam, flux))
    resid, dof = [], 0
    for pts in by_det.values():
        n = len(pts)
        deg = min(2, n - 2)
        if deg < 0:
            continue
        x = np.log([lam for lam, _ in pts])
        y = np.array([flux for _, flux in pts])
        if np.median(y) <= 0:
            continue
        model = np.polyval(np.polyfit(x - x.mean(), y, deg), x - x.mean())
        if np.any(model <= 0):
            continue
        r = y / model - 1
        resid.extend(r * np.sqrt(n / (n - deg - 1)))
        dof += n - deg - 1
    if dof < MIN_DOF:
        return None
    r = np.array(resid)
    return float(1.4826 * np.median(np.abs(r - np.median(r))))


def comparison(
    frames: list[dict], target_xy: tuple[float, float], r_px: float = 2.0, grid_wcs: WCS | None = None
) -> dict | None:
    """{"n_stars", "rms_frac"} from 3-6 field stars, or None when the field has too few usable stars."""
    stars = pick_comparison_stars(frames, target_xy, r_px)
    scatters = []
    for sx, sy in stars:
        world = SkyCoord.from_pixel(sx, sy, grid_wcs) if grid_wcs is not None else None
        pts = []
        for f in frames:
            p = measure(f, sx, sy, r_px, world)
            if p is not None and not p["flagged"]:
                pts.append((f["detector"], f["lam_um"], p["flux_ujy"]))
        s = spectral_scatter(pts)
        if s is not None:
            scatters.append(s)
    if len(scatters) < MIN_COMP_STARS:
        return None
    return {"n_stars": len(scatters), "rms_frac": round(float(np.median(scatters)), 4)}
