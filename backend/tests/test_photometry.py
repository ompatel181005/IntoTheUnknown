"""Forced photometry and comparison-star scatter on synthetic frames (no network, no demo pack)."""

import numpy as np
from astropy.coordinates import SkyCoord

from app.processing import photometry, stack

N = 61  # grid size, px
RA, DEC = 180.0, 0.0
RNG = np.random.default_rng(31)


def gaussian(x0: float, y0: float, total: float, sigma: float = 0.6) -> np.ndarray:
    yy, xx = np.mgrid[0:N, 0:N]
    g = np.exp(-((xx - x0) ** 2 + (yy - y0) ** 2) / (2 * sigma**2))
    return total * g / g.sum()


def frame(img: np.ndarray, lam_um: float = 1.0, t_mjd: float = 61000.0, flags=None, flag_names=None) -> dict:
    w, _ = stack.common_grid(RA, DEC, N * stack.PIX_ARCSEC / 60)
    return {
        "_grid": (img, np.ones_like(img)),
        "t_mjd": t_mjd,
        "lam_um": lam_um,
        "detector": 1,
        "flags": flags if flags is not None else np.zeros(img.shape, "i4"),
        "flag_names": flag_names or {},
        "wcs_header": w.to_header(),
    }


def test_synthetic_source_recovered_within_5_percent():
    total = 50.0  # MJy/sr summed over the source's pixels
    img = gaussian(30.3, 29.6, total) + 0.7 + RNG.normal(0, 0.002, (N, N))  # sky offset is removed by the annulus
    p = photometry.measure(frame(img), 30.3, 29.6, r_px=2.0)
    expected = total * photometry.UJY_PER_MJYSR_PIX
    assert abs(p["flux_ujy"] / expected - 1) < 0.05, (p["flux_ujy"], expected)
    assert p["err"] > 0 and p["flagged"] is False


def test_masked_pixel_in_aperture_is_flagged():
    img = gaussian(30, 30, 50.0)
    img[30, 31] = np.nan  # a flag-masked pixel (stack.to_grid sets these to NaN)
    assert photometry.measure(frame(img), 30, 30, 2.0)["flagged"] is True


def test_saturated_core_is_flagged_from_native_flags():
    img = gaussian(30, 30, 50.0)
    flags = np.zeros((N, N), "i4")
    flags[30, 30] = 1 << 5
    f = frame(img, flags=flags, flag_names={"OVERFLOW": 5})
    w, _ = stack.common_grid(RA, DEC, N * stack.PIX_ARCSEC / 60)
    assert photometry.measure(f, 30, 30, 2.0, SkyCoord.from_pixel(30, 30, w))["flagged"] is True
    assert photometry.measure(f, 15, 15, 2.0, SkyCoord.from_pixel(15, 15, w))["flagged"] is False


def field(n_frames: int = 12, noise_frac: float = 0.02, stars=((12, 12), (48, 14), (14, 47), (47, 46), (30, 50))):
    """Frames of a static field, each at a different wavelength (as SPHEREx sees it); every star has its own
    power-law spectrum, which must not count as scatter."""
    frames = []
    for i in range(n_frames):
        lam = 0.80 + 0.024 * i  # across detector 1
        img = RNG.normal(0, 0.001, (N, N))
        for k, (sx, sy) in enumerate(stars):
            colour = lam ** (2.0 * k - 4.0)  # flux varies by up to ~2.5x across the detector
            img += gaussian(sx, sy, 30.0 * colour * (1 + RNG.normal(0, noise_frac)))
        frames.append(frame(img, lam_um=lam, t_mjd=61000.0 + i))
    return frames


def test_comparison_scatter_measures_the_noise_not_the_spectrum():
    comp = photometry.comparison(field(noise_frac=0.02), target_xy=(30, 30))
    assert comp is not None and 3 <= comp["n_stars"] <= 6
    assert 0.005 < comp["rms_frac"] < 0.05, comp


def test_comparison_without_spectral_fit_would_fail():
    """Guard: the raw scatter of these stars is dominated by their spectra, far above the 2% noise."""
    frames = field(noise_frac=0.0)
    raw = [photometry.measure(f, 12, 12, 2.0)["flux_ujy"] for f in frames]
    assert np.std(raw) / np.mean(raw) > 0.2
    comp = photometry.comparison(frames, target_xy=(30, 30))
    assert comp is not None and comp["rms_frac"] < 0.01, comp


def test_comparison_skips_the_target_and_needs_three_stars():
    frames = field(stars=((30, 30), (12, 12), (48, 14)))  # the first star sits on the target
    assert photometry.comparison(frames, target_xy=(30, 30)) is None


def test_barnard_lightcurve_end_to_end():
    """Barnard's core saturates SPHEREx: every point is marked, and the field gives a calibration floor."""
    import time

    from fastapi.testclient import TestClient

    from app.main import app

    client = TestClient(app)
    r = client.post("/api/views", json={"ra": 269.44627, "dec": 4.7682, "fov_arcmin": 6, "band": "B1-B2"})
    view_id = r.json()["view_id"]
    deadline = time.time() + 60
    while (body := client.get(f"/api/views/{view_id}").json())["status"] not in ("ready", "error"):
        assert time.time() < deadline, "view did not finish"
        time.sleep(0.2)
    assert body["status"] == "ready", body
    n = client.get(body["manifest_url"]).json()["grid"]["nx"]
    lc = client.get(f"/api/views/{view_id}/lightcurve", params={"x": n // 2, "y": n // 2}).json()
    assert lc["points"] and all(p["flagged"] for p in lc["points"])
    assert lc["comparison"]["n_stars"] >= 3 and 0 < lc["comparison"]["rms_frac"] < 0.2
