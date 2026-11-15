"""Offline assessment of the actual saved stacks; no production astrometry imports.

Catalogue constants are pinned separately from the production predictor. Gaia values
are recorded in docs/TARGETS.md and the bundled Gaia DR3 CSVs. WISE's reference is
explicitly provisional. Aperture statistics below are diagnostics, not calibrated
photometry or a completeness estimate.
"""

import hashlib
import json
from pathlib import Path

import astropy.units as u
import numpy as np
from astropy.coordinates import (
    Distance,
    SkyCoord,
    get_body_barycentric,
    solar_system_ephemeris,
)
from astropy.stats import sigma_clipped_stats
from astropy.time import Time
from astropy.utils import iers
from astropy.wcs import WCS

iers.conf.auto_download = False

# ra, dec, pmra*cos(dec), pmdec, parallax; Gaia J2016.0 unless noted.
REFERENCES = {
    "barnard": (269.448503, 4.739420, -801.6, 10362.4, 546.98),
    "eps-ind-b": (
        331.07645259656397,
        -56.79381206688221,
        3981.97666296105,
        -2466.8318147663504,
        270.6580324694526,
    ),
    "wise-0855": (133.783924, -7.2443404, -8120.0, 680.0, 439.0),
    "rw-aur": (76.956081196, 30.401204589, 2.641, -27.398, 6.406),
    "r-dra": (248.167378367, 66.755006745, -20.643, 6.149, 1.251),
}
SOURCE_IDS = {
    "barnard": "4472832130942575872",
    "eps-ind-b": "6412596012146801152",
    "rw-aur": "156430822114424576",
    "r-dra": "1648328016354496384",
}
NAMES = {
    "barnard": "Barnard's Star",
    "eps-ind-b": "epsilon Indi B",
    "wise-0855": "WISE 0855",
    "rw-aur": "RW Aur",
    "r-dra": "R Dra",
}


def predict_target(target_id, mjd):
    """Independent Astropy space motion plus first-order Earth parallax, no aberration.

    Retains the established Barnard calculation exactly. Unknown radial velocity
    is zero; this is an explicit approximation, not a fitted parameter.
    """
    ra, dec, pmra, pmdec, plx = REFERENCES[target_id]
    epoch = (
        Time(57170.0, format="mjd", scale="tdb")
        if target_id == "wise-0855"
        else Time(2016.0, format="jyear", scale="tcb")
    )
    source = SkyCoord(
        ra=ra * u.deg,
        dec=dec * u.deg,
        pm_ra_cosdec=pmra * u.mas / u.yr,
        pm_dec=pmdec * u.mas / u.yr,
        distance=Distance(parallax=plx * u.mas),
        radial_velocity=0 * u.km / u.s,
        obstime=epoch,
    )
    t = Time(mjd, format="mjd", scale="utc")
    moved = source.apply_space_motion(new_obstime=t)
    a, d = moved.ra.rad, moved.dec.rad
    with solar_system_ephemeris.set("builtin"):
        x, y, z = get_body_barycentric("earth", t).xyz.to_value(u.au)
    da = plx * (x * np.sin(a) - y * np.cos(a)) / (3.6e6 * np.cos(d))
    dd = (
        plx
        * (x * np.cos(a) * np.sin(d) + y * np.sin(a) * np.sin(d) - z * np.cos(d))
        / 3.6e6
    )
    return [float(moved.ra.deg + da), float(moved.dec.deg + dd)]


def _aperture(image, xy):
    # Both the aperture and its background annulus must fit inside the image.
    if not all(np.isfinite(xy)) or not (
        7 <= xy[0] <= image.shape[1] - 8 and 7 <= xy[1] <= image.shape[0] - 8
    ):
        return None
    yy, xx = np.indices(image.shape)
    radius = np.hypot(xx - xy[0], yy - xy[1])
    values = image[radius <= 2.2]
    annulus = image[(radius >= 4) & (radius <= 7)]
    finite = annulus[np.isfinite(annulus)]
    # An incomplete aperture is not an upper limit or a detection.
    if not values.size or not np.isfinite(values).all() or finite.size < 20:
        return None
    return float(np.sum(values - np.median(finite)))


def aperture_diagnostic(image, xy):
    """Forced flux and empirical blank-aperture scatter in image-unit pixels.

    Blank apertures use the same sum/background operator, retaining resampling
    correlations. A fixed grid makes the diagnostic reproducible. Clipping
    removes bright field-source contamination, but this is not a source-injection
    or false-positive calibration. No '5 sigma detection' claim follows alone.
    """
    flux = _aperture(image, xy)
    blank = []
    for y in range(8, image.shape[0] - 8, 5):
        for x in range(8, image.shape[1] - 8, 5):
            if np.hypot(x - xy[0], y - xy[1]) < 9:
                continue
            value = _aperture(image, (x, y))
            if value is not None:
                blank.append(value)
    noise = None
    if len(blank) >= 20:
        _, _, sigma = sigma_clipped_stats(blank, sigma=3, maxiters=5)
        if np.isfinite(sigma) and sigma > 0:
            noise = float(sigma)
    return {
        "forced_aperture_sum_mjysr_pixels": flux,
        "blank_apertures": len(blank),
        "empirical_aperture_noise_mjysr_pixels": noise,
        "diagnostic_snr": flux / noise if flux is not None and noise else None,
        "aperture_complete": flux is not None,
    }


def assess_gates(target_id, manifest, epochs):
    """Fail missing prerequisites; a numerical fit alone cannot establish science."""
    motion = target_id in ("barnard", "eps-ind-b", "wise-0855")
    enough = len(epochs) >= 2
    centroided = enough and all(e.get("centroid_px") is not None for e in epochs)

    def finite_pair(value):
        try:
            pair = np.asarray(value, dtype=float)
            return pair.shape == (2,) and bool(np.isfinite(pair).all())
        except (TypeError, ValueError):
            return False

    finite_astrometry = centroided and all(
        finite_pair(e.get("centroid_px"))
        and finite_pair(e.get("predicted_px"))
        and e.get("residual_px") is not None
        and np.isfinite(e["residual_px"])
        and e["residual_px"] >= 0
        for e in epochs
    )
    vector_error = max_residual = None
    if finite_astrometry:
        actual = np.subtract(epochs[-1]["centroid_px"], epochs[0]["centroid_px"])
        expected = np.subtract(epochs[-1]["predicted_px"], epochs[0]["predicted_px"])
        vector_error = float(np.linalg.norm(actual - expected))
        max_residual = max(e["residual_px"] for e in epochs)
    snr_epochs = sum(
        e.get("diagnostic_snr") is not None
        and np.isfinite(e["diagnostic_snr"])
        and e["diagnostic_snr"] >= 5
        for e in epochs
    )
    gates = {"at_least_two_epochs": enough}
    unestablished = []
    if motion:
        limit = 0.4 if target_id == "wise-0855" else 0.2
        gates.update(
            reference_verified=target_id != "wise-0855",
            centroids_available=centroided,
            finite_astrometry_every_epoch=bool(finite_astrometry),
            vector_error_within_limit=vector_error is not None
            and vector_error <= limit,
        )
        if target_id == "barnard":
            gates["maximum_position_residual_below_0_3_px"] = (
                max_residual is not None and max_residual < 0.3
            )
        elif target_id == "eps-ind-b":
            gates["each_position_within_0_2_px"] = (
                max_residual is not None and max_residual <= 0.2
            )
            gates["source_above_empirical_noise_each_epoch"] = (
                snr_epochs == len(epochs) and enough
            )
        else:
            gates["at_least_two_diagnostic_snr_5_epochs"] = snr_epochs >= 2
            gates["independent_detection_significance_calibrated"] = False
            gates["detected_source_gaia_association_checked"] = False
            unestablished = [
                "reference_verified",
                "independent_detection_significance_calibrated",
                "detected_source_gaia_association_checked",
            ]
        gates["matched_wavelength_channels"] = manifest.get("bandpass_matched") is True
    else:
        # Broad-band rendered aperture sums cannot substitute for the specified
        # per-band, unsaturated light curve plus independently checked calibration.
        gates.update(
            matched_wavelength_channels=manifest.get("bandpass_matched") is True,
            per_band_fluxes_with_validated_errors=False,
            target_saturation_checked_per_input=False,
            comparison_star_calibration_floor_established=False,
        )
        if target_id == "r-dra":
            gates.update(
                amplitude_above_20_percent_and_comparison_floor=False,
                independently_verified_period_and_phase=False,
            )
        unestablished = [
            name
            for name in gates
            if name not in ("at_least_two_epochs", "matched_wavelength_channels")
        ]
    return {
        "science_status": "PASS" if all(gates.values()) else "FAIL",
        "gates": gates,
        "failed_gates": [name for name, passed in gates.items() if not passed],
        "vector_error_px": vector_error,
        "maximum_residual_px": max_residual,
        "diagnostic_snr_5_epochs": snr_epochs,
        "not_established_by_this_assessment": unestablished,
    }


def assess_target(target_id, manifest, folder, measure):
    """Read the exact rendered floats and real epoch MJDs for one target."""
    wcs = WCS(manifest["grid"]["wcs"])
    shape = manifest["grid"]["ny"], manifest["grid"]["nx"]
    epochs = []
    for row in manifest["epochs"]:
        image = np.fromfile(folder / row["image"], dtype="<f4").reshape(shape)
        radec = predict_target(target_id, row["t_mean_mjd"])
        expected = wcs.all_world2pix([radec], 0)[0]
        entry = {
            "mjd": row["t_mean_mjd"],
            "n_frames": row["n_frames"],
            "finite_fraction": float(np.isfinite(image).mean()),
            "predicted_radec": radec,
            "predicted_px": [float(v) for v in expected],
            "wavelength_um": row["lambda_um"],
            **aperture_diagnostic(image, expected),
        }
        window_inside = bool(
            np.isfinite(expected).all()
            and 3 <= round(expected[0]) < shape[1] - 3
            and 3 <= round(expected[1]) < shape[0] - 3
        )
        strong_enough = target_id != "wise-0855" or (
            entry["diagnostic_snr"] is not None and entry["diagnostic_snr"] >= 5
        )
        if window_inside and strong_enough:
            try:
                entry.update(measure(image, expected))
                entry["centroid_role"] = "diagnostic fit; not an independent detection"
            except (ValueError, FloatingPointError) as error:
                entry["centroid_failure"] = str(error)
        else:
            entry["centroid_failure"] = (
                "Not fitted: complete centroid window is outside the image."
                if not window_inside
                else "Not fitted: forced aperture does not meet the diagnostic S/N gate."
            )
        epochs.append(entry)
    result = {
        "epochs": epochs,
        "bandpass_matched": manifest.get("bandpass_matched"),
        "frames": len(manifest["frames"]),
        "render_key": manifest["render_key"],
        "reference": {
            "parameters": list(REFERENCES[target_id]),
            "source_id": SOURCE_IDS.get(target_id),
            "epoch": "MJD 57170 TDB" if target_id == "wise-0855" else "J2016.0 TCB",
            "provenance": "CatWISE2020 position; unverified literature motion/parallax"
            if target_id == "wise-0855"
            else "Pinned Gaia DR3; docs/TARGETS.md and bundled Gaia CSV",
            "radial_velocity_kms": 0,
            "predictor": "Independent validation implementation; offline builtin Earth ephemeris",
        },
        **assess_gates(target_id, manifest, epochs),
    }
    if len(epochs) >= 2 and all(e.get("centroid_px") is not None for e in epochs):
        result["measured_shift_px"] = float(
            np.linalg.norm(
                np.subtract(epochs[-1]["centroid_px"], epochs[0]["centroid_px"])
            )
        )
        result["predicted_shift_px"] = float(
            np.linalg.norm(
                np.subtract(epochs[-1]["predicted_px"], epochs[0]["predicted_px"])
            )
        )
    result["manifest_sha256"] = hashlib.sha256(
        (folder / "manifest.json").read_bytes()
    ).hexdigest()
    result["assessment_complete"] = True
    return result


def assess_saved(root: Path, measure):
    reports = {}
    for target in REFERENCES:
        folder = root / target
        manifest = json.loads((folder / "manifest.json").read_text(encoding="utf8"))
        reports[target] = assess_target(target, manifest, folder, measure)
    return reports
