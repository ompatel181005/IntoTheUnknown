"""Epoch grouping, channel-matched stacking, shared stretch. From docs/skeletons/stack.py."""

import logging
import warnings

import numpy as np
from astropy.stats import sigma_clipped_stats
from astropy.wcs import WCS
from reproject import reproject_interp

PIX_ARCSEC = 6.15
BANDS = {1: (0.75, 1.09), 2: (1.10, 1.62), 3: (1.63, 2.41), 4: (2.42, 3.82), 5: (3.83, 4.41), 6: (4.42, 5.00)}
KEEP = {"SOURCE", "OVERFLOW", "NONLINEAR", "FULLSAMPLE", "HALO", "BLOOM"}  # not masked for imaging (tune)
log = logging.getLogger(__name__)


def group_epochs(frames, gap_days=20.0, max_len_days=40.0) -> list[list[dict]]:
    epochs, cur = [], []
    for f in sorted(frames, key=lambda f: f["t_mjd"]):
        if cur and (f["t_mjd"] - cur[-1]["t_mjd"] > gap_days or f["t_mjd"] - cur[0]["t_mjd"] > max_len_days):
            epochs.append(cur)
            cur = []
        cur.append(f)
    return epochs + ([cur] if cur else [])


def common_grid(ra, dec, fov_arcmin) -> tuple[WCS, tuple[int, int]]:
    n = int(np.ceil(fov_arcmin * 60 / PIX_ARCSEC)) | 1
    w = WCS(naxis=2)
    w.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    w.wcs.crval = [ra, dec]
    w.wcs.crpix = [(n + 1) / 2, (n + 1) / 2]
    w.wcs.cdelt = [-PIX_ARCSEC / 3600, PIX_ARCSEC / 3600]
    return w, (n, n)


def channel_of(f) -> tuple[int, int]:
    lo, hi = BANDS[f["detector"]]
    return f["detector"], int(np.clip(np.log(f["lam_um"] / lo) / np.log(hi / lo) * 17, 0, 16))


def to_grid(f, w, shape):
    names = f["flag_names"]
    bits = sum(1 << b for name, b in names.items() if name not in KEEP)
    flags = f["flags"]
    # DECISIONS 2026-11-14 13:40: TRANSIENT and SUR_ERROR must not mask SOURCE pixels (bright star cores).
    if "SOURCE" in names:
        soft = sum(1 << names[n] for n in ("TRANSIENT", "SUR_ERROR") if n in names)
        flags = np.where((flags & (1 << names["SOURCE"])) != 0, flags & ~soft, flags)
    img = np.where((flags & bits) != 0, np.nan, f["image"])
    _, sky, _ = sigma_clipped_stats(img, sigma=3)
    src = WCS(f["wcs_header"])
    im, _ = reproject_interp((img - sky, src), w, shape_out=shape)
    if f.get("var") is None:  # demo pack has no VARIANCE: equal weights
        var = np.where(np.isfinite(im), 1.0, np.nan)
    else:
        var, _ = reproject_interp((f["var"], src), w, shape_out=shape)
    return im, var


def stack_epochs(epochs, w, shape):
    """Channel-matched: inverse-variance mean per channel, then equal-weight mean over channels common to all epochs."""
    per = []
    for ep in epochs:
        chans: dict = {}
        for f in ep:
            chans.setdefault(channel_of(f), []).append(f.get("_grid") or to_grid(f, w, shape))
        per.append(chans)
    keys = [set(c) for c in per]
    common = set.intersection(*keys)
    matched = bool(common)
    use = common or set.union(*keys)
    stacks = []
    for chans in per:
        layers = []
        for k in sorted(use & chans.keys()):
            ims = np.array([im for im, _ in chans[k]])
            wts = np.array([1.0 / v for _, v in chans[k]])
            ok = np.isfinite(ims) & np.isfinite(wts) & (wts > 0)
            num = np.where(ok, ims * wts, 0).sum(0)
            den = np.where(ok, wts, 0).sum(0)
            layers.append(np.where(den > 0, num / np.where(den > 0, den, 1), np.nan))
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", RuntimeWarning)  # all-NaN pixels stay NaN
            stacks.append(np.nanmean(layers, axis=0) if layers else np.full(shape, np.nan))
    return stacks, {"channels": sorted(use), "bandpass_matched": matched}


def aperture_flux(im, x, y, r_px=2.0, ann=(4.0, 7.0)) -> float:
    """Background-subtracted aperture sum (image units x pixels); NaN if any aperture pixel is masked."""
    ny, nx = im.shape
    yy, xx = np.mgrid[0:ny, 0:nx]
    d = np.hypot(xx - x, yy - y)
    vals, bkg = im[d <= r_px], im[(d >= ann[0]) & (d <= ann[1])]
    bkg = bkg[np.isfinite(bkg)]
    if not np.isfinite(vals).all() or bkg.size < 5:
        return np.nan
    return float(vals.sum() - vals.size * np.median(bkg))


def phot_scales(stacks, nsig=5.0, min_stars=3, exclude_px=4.0, tol=0.05) -> list[float]:
    """PLAN 5.5: per epoch, the median field-star flux ratio against epoch 0.

    Field stars are >= nsig peaks in epoch 0, away from the edges and from the target at the grid centre, so the
    target's own variability never sets the scale. Fewer than min_stars usable stars gives 1.0.
    """
    if len(stacks) < 2:
        return [1.0] * len(stacks)
    ref = stacks[0]
    ny, nx = ref.shape
    _, sky, sig = sigma_clipped_stats(ref[np.isfinite(ref)], sigma=3)
    p = np.pad(np.where(np.isfinite(ref), ref, -np.inf), 1, constant_values=-np.inf)
    neigh = np.max([p[1 + dy : ny + 1 + dy, 1 + dx : nx + 1 + dx] for dy in (-1, 0, 1) for dx in (-1, 0, 1)], axis=0)
    ys, xs = np.nonzero((ref > sky + nsig * sig) & (ref >= neigh))
    m, c = 8, ((nx - 1) / 2, (ny - 1) / 2)  # 8 px edge margin covers the 7 px annulus
    stars = [
        (x, y)
        for x, y in zip(xs, ys)
        if m <= x < nx - m and m <= y < ny - m and np.hypot(x - c[0], y - c[1]) > exclude_px
    ]
    ref_f = np.array([aperture_flux(ref, x, y) for x, y in stars])
    scales = [1.0]
    for i, s in enumerate(stacks[1:], 1):
        f = np.array([aperture_flux(s, x, y) for x, y in stars])
        ok = np.isfinite(f) & np.isfinite(ref_f) & (ref_f > 0)
        scale = float(np.median(f[ok] / ref_f[ok])) if ok.sum() >= min_stars else 1.0
        if abs(scale - 1) > tol:
            log.warning("phot_scale epoch %d = %.3f from %d field stars (outside 1 +/- %.2f)", i, scale, ok.sum(), tol)
        scales.append(scale)
    return scales


def shared_asinh(stacks, beta_sigma=3.0, hi_pct=99.7) -> dict:
    pool = np.concatenate([s[np.isfinite(s)] for s in stacks])
    _, sky, sig = sigma_clipped_stats(pool, sigma=3)
    return {
        "kind": "asinh",
        "vmin": float(sky - 2 * sig),
        "vmax": float(np.percentile(pool, hi_pct)),
        "beta": float(beta_sigma * sig),
    }  # applied identically to every epoch
