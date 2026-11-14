# SKELETON from the hackathon plan: not yet run against live IRSA or Azure.
# Destination: backend/app/processing/stack.py. Copy it there when you start that slice and delete this file in the same PR.

import numpy as np
from astropy.stats import sigma_clipped_stats
from astropy.wcs import WCS
from reproject import reproject_interp

PIX_ARCSEC = 6.15
BANDS = {1: (0.75, 1.09), 2: (1.10, 1.62), 3: (1.63, 2.41), 4: (2.42, 3.82), 5: (3.83, 4.41), 6: (4.42, 5.00)}
KEEP = {"SOURCE", "OVERFLOW", "NONLINEAR", "FULLSAMPLE", "HALO", "BLOOM"}   # not masked for imaging (tune)

def group_epochs(frames, gap_days=20.0, max_len_days=40.0) -> list[list[dict]]:
    epochs, cur = [], []
    for f in sorted(frames, key=lambda f: f["t_mjd"]):
        if cur and (f["t_mjd"] - cur[-1]["t_mjd"] > gap_days or f["t_mjd"] - cur[0]["t_mjd"] > max_len_days):
            epochs.append(cur); cur = []
        cur.append(f)
    return epochs + ([cur] if cur else [])

def common_grid(ra, dec, fov_arcmin) -> tuple[WCS, tuple[int, int]]:
    n = int(np.ceil(fov_arcmin * 60 / PIX_ARCSEC)) | 1
    w = WCS(naxis=2)
    w.wcs.ctype = ["RA---TAN", "DEC--TAN"]; w.wcs.crval = [ra, dec]
    w.wcs.crpix = [(n + 1) / 2, (n + 1) / 2]; w.wcs.cdelt = [-PIX_ARCSEC / 3600, PIX_ARCSEC / 3600]
    return w, (n, n)

def channel_of(f) -> tuple[int, int]:
    lo, hi = BANDS[f["detector"]]
    return f["detector"], int(np.clip(np.log(f["lam_um"] / lo) / np.log(hi / lo) * 17, 0, 16))

def to_grid(f, w, shape):
    bits = sum(1 << b for name, b in f["flag_names"].items() if name not in KEEP)
    img = np.where((f["flags"] & bits) != 0, np.nan, f["image"])
    _, sky, _ = sigma_clipped_stats(img, sigma=3)
    src = WCS(f["wcs_header"])
    im, _ = reproject_interp((img - sky, src), w, shape_out=shape)
    var, _ = reproject_interp((f["var"], src), w, shape_out=shape)
    return im, var

def stack_epochs(epochs, w, shape):
    """Channel-matched: inverse-variance mean per channel, then equal-weight mean over channels common to all epochs."""
    per = []
    for ep in epochs:
        chans: dict = {}
        for f in ep:
            chans.setdefault(channel_of(f), []).append(to_grid(f, w, shape))
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
            num = np.where(ok, ims * wts, 0).sum(0); den = np.where(ok, wts, 0).sum(0)
            layers.append(np.where(den > 0, num / np.where(den > 0, den, 1), np.nan))
        stacks.append(np.nanmean(layers, axis=0) if layers else np.full(shape, np.nan))
    return stacks, {"channels": sorted(use), "bandpass_matched": matched}

def shared_asinh(stacks, beta_sigma=3.0, hi_pct=99.7) -> dict:
    pool = np.concatenate([s[np.isfinite(s)] for s in stacks])
    _, sky, sig = sigma_clipped_stats(pool, sigma=3)
    return {"kind": "asinh", "vmin": float(sky - 2 * sig), "vmax": float(np.percentile(pool, hi_pct)),
            "beta": float(beta_sigma * sig)}                       # applied identically to every epoch
