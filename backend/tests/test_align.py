"""Alignment check (issue #15): an injected offset is found and corrected; too few stars degrades to None."""

from pathlib import Path

import numpy as np

from app.processing import align, stack

RA, DEC, MJD = 150.0, 20.0, 61000.0
W, SHAPE = stack.common_grid(RA, DEC, 6)
RNG = np.random.default_rng(15)
# 12 well-separated stars on a jittered ring pattern, as sky positions at the Gaia epoch (no motion).
PIX = np.array([(12 + 12 * (i % 4) + RNG.uniform(-2, 2), 12 + 16 * (i // 4) + RNG.uniform(-2, 2)) for i in range(12)])
STARS = [
    {"ra": float(r), "dec": float(d), "pmra": 0.0, "pmdec": 0.0, "plx": 1.0, "gmag": 12.0}
    for r, d in zip(*W.all_pix2world(PIX[:, 0], PIX[:, 1], 0))
]


def frame(dx=0.0, dy=0.0, t=MJD, lam=1.0) -> dict:
    """A cutout already on the view grid whose WCS is wrong by (dx, dy) px: the stars are drawn shifted."""
    yy, xx = np.mgrid[0 : SHAPE[0], 0 : SHAPE[1]]
    img = RNG.normal(0, 0.01, SHAPE)
    for x, y in PIX:
        img += 5.0 * np.exp(-((xx - x - dx) ** 2 + (yy - y - dy) ** 2) / (2 * 1.1**2))
    return {
        "image": img.astype("f4"), "var": None, "flags": np.zeros(SHAPE, "i4"), "flag_names": {},
        "wcs_header": W.to_header(), "detector": 1, "lam_um": lam, "t_mjd": t,
    }  # fmt: skip


def test_aligned_epoch_measures_no_offset():
    _, _, astrom = align.align_epochs([[frame(), frame()]], W, SHAPE, STARS)
    a = astrom[0]
    assert a["n_stars"] >= 8 and np.hypot(a["dx"], a["dy"]) < 0.05 and a["resid_px"] < 0.05


def test_injected_offset_is_detected_and_corrected():
    good, bad = [frame(), frame()], [frame(0.3, -0.1, MJD + 180), frame(0.3, -0.1, MJD + 181)]
    for ep in (good, bad):
        for f in ep:
            f["_grid"] = stack.to_grid(f, W, SHAPE)
    before = align.measure(stack.stack_epochs([good, bad], W, SHAPE)[0][1], align.field_stars(STARS, W, SHAPE, MJD))
    assert abs(before["dx"] - 0.3) < 0.05 and abs(before["dy"] + 0.1) < 0.05
    _, _, astrom = align.align_epochs([good, bad], W, SHAPE, STARS)
    assert np.hypot(astrom[1]["dx"], astrom[1]["dy"]) < 0.1


def test_too_few_stars_is_none_not_an_error():
    _, _, astrom = align.align_epochs([[frame()]], W, SHAPE, STARS[:2])
    assert astrom == [None]
    assert align.align_epochs([[frame()]], W, SHAPE, [])[2] == [None]
    assert align.load_gaia_csv(Path("/nonexistent/gaia.csv")) == []


def test_fast_and_blended_stars_are_not_reference_stars():
    fast = {**STARS[0], "pmra": 5000.0}
    twin = {**STARS[1], "ra": STARS[1]["ra"] + 6.15 / 3600}  # 1 px away, same brightness
    xy = align.field_stars([fast, STARS[1], twin, *STARS[2:]], W, SHAPE, MJD)
    assert len(xy) == len(STARS) - 2
