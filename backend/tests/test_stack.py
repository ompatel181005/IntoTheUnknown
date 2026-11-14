"""Offline checks for stack.py on synthetic frames (issue #11). No network, no demo pack."""

import numpy as np
from astropy.wcs import WCS

from app.processing import stack

RA, DEC, FOV = 150.0, 20.0, 4
NAMES = {"TRANSIENT": 0, "SUR_ERROR": 2, "HOT": 10, "SOURCE": 21}


def gauss(shape, x, y, flux, sigma=0.8):
    yy, xx = np.mgrid[0 : shape[0], 0 : shape[1]]
    return flux * np.exp(-((xx - x) ** 2 + (yy - y) ** 2) / (2 * sigma**2)) / (2 * np.pi * sigma**2)


def frame(t_mjd, stars, lam=1.0, rot_deg=7.0, seed=0, flags=None):
    """A 60x60 cutout on its own rotated TAN WCS; stars = [(ra, dec, flux)]. Noise sigma 0.01."""
    n = 60
    w = WCS(naxis=2)
    w.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    w.wcs.crval = [RA, DEC]
    w.wcs.crpix = [n / 2 + 0.3, n / 2 - 0.2]
    c, s, d = np.cos(np.radians(rot_deg)), np.sin(np.radians(rot_deg)), stack.PIX_ARCSEC / 3600
    w.wcs.cd = [[-d * c, d * s], [d * s, d * c]]
    img = np.random.default_rng(seed).normal(0, 0.01, (n, n))
    for ra, dec, flux in stars:
        x, y = w.world_to_pixel_values(ra, dec)
        img += gauss((n, n), float(x), float(y), flux)
    return {
        "t_mjd": t_mjd,
        "detector": 1,
        "lam_um": lam,
        "image": img,
        "flags": np.zeros((n, n), np.int64) if flags is None else flags,
        "flag_names": NAMES,
        "wcs_header": w.to_header(),
        "var": None,
    }


def centroid(im, x0, y0, r=3):
    yy, xx = np.mgrid[0 : im.shape[0], 0 : im.shape[1]]
    m = (np.hypot(xx - x0, yy - y0) <= r) & np.isfinite(im)
    wts = np.clip(im, 0, None) * m
    return (wts * xx).sum() / wts.sum(), (wts * yy).sum() / wts.sum()


def test_group_epochs_gap_and_max_length():
    epochs = stack.group_epochs([{"t_mjd": t} for t in (0, 5, 10, 200, 205, 400, 415, 430, 445)])
    assert [len(e) for e in epochs] == [3, 2, 3, 1]


def test_channel_bins_clip_at_band_edges():
    assert stack.channel_of({"detector": 1, "lam_um": 0.75}) == (1, 0)
    assert stack.channel_of({"detector": 1, "lam_um": 1.09}) == (1, 16)
    assert stack.channel_of({"detector": 6, "lam_um": 4.70}) == (6, 8)


def test_injected_shift_recovered_after_stacking():
    w, shape = stack.common_grid(RA, DEC, FOV)
    shift_px = 1.7  # Barnard's Star in a year, due north
    dra = 0.6 * stack.PIX_ARCSEC / 3600  # mover sits off the grid centre
    ddec = shift_px * stack.PIX_ARCSEC / 3600
    a = [frame(60000 + k, [(RA + dra, DEC, 50.0)], lam=0.9, rot_deg=5 + k, seed=k) for k in range(3)]
    b = [frame(60365 + k, [(RA + dra, DEC + ddec, 50.0)], lam=0.9, rot_deg=-8 + k, seed=10 + k) for k in range(3)]
    stacks, info = stack.stack_epochs(stack.group_epochs(a + b), w, shape)
    assert len(stacks) == 2 and info["bandpass_matched"]
    x0, y0 = w.world_to_pixel_values(RA + dra, DEC)
    xa, ya = centroid(stacks[0], float(x0), float(y0))
    xb, yb = centroid(stacks[1], float(x0), float(y0) + shift_px)
    assert abs((yb - ya) - shift_px) < 0.2 and abs(xb - xa) < 0.2, (xb - xa, yb - ya)


def test_source_core_survives_transient_flags():
    """Spike #4: TRANSIENT/SUR_ERROR on a SOURCE pixel must not blank a bright star's core; HOT still masks."""
    w, shape = stack.common_grid(RA, DEC, FOV)
    f = frame(60000, [(RA, DEC, 50.0)], rot_deg=0)
    flags = np.zeros((60, 60), np.int64)
    flags[29:32, 29:32] = (1 << 21) | (1 << 0) | (1 << 2)  # SOURCE + TRANSIENT + SUR_ERROR on the core
    flags[30, 40] = 1 << 10  # a HOT pixel 10 px from the core, inside the grid
    f["flags"] = flags
    im, _ = stack.to_grid(f, w, shape)
    c = (shape[0] - 1) // 2
    assert np.isfinite(im[c - 1 : c + 2, c - 1 : c + 2]).all()
    assert not np.isfinite(im).all()  # the HOT pixel was masked


def test_phot_scale_from_field_stars_ignores_variable_target():
    shape = (41, 41)
    field = [(10, 10), (30, 12), (12, 29), (28, 30), (20, 33)]
    rng = np.random.default_rng(1)

    def epoch(gain, target_flux):
        im = rng.normal(0, 0.01, shape)
        for x, y in field:
            im += gain * gauss(shape, x, y, 20.0)
        return im + gauss(shape, 20, 20, target_flux)  # the target, at the centre

    stacks = [epoch(1.0, 30.0), epoch(1.1, 90.0), epoch(0.95, 5.0)]
    scales = stack.phot_scales(stacks)
    assert scales[0] == 1.0
    assert abs(scales[1] - 1.1) < 0.02 and abs(scales[2] - 0.95) < 0.02, scales


def test_phot_scale_falls_back_without_field_stars():
    rng = np.random.default_rng(2)
    stacks = [rng.normal(0, 0.01, (41, 41)) for _ in range(2)]
    assert stack.phot_scales(stacks) == [1.0, 1.0]


def test_single_epoch_stacks():
    w, shape = stack.common_grid(RA, DEC, FOV)
    stacks, info = stack.stack_epochs([[frame(60000, [(RA, DEC, 50.0)])]], w, shape)
    assert len(stacks) == 1 and np.isfinite(stacks[0]).mean() > 0.5 and info["bandpass_matched"]
    assert stack.phot_scales(stacks) == [1.0]
