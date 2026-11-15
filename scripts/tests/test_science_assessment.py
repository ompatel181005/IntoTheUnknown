"""Science gates fail missing or weak evidence instead of promoting a fitted noise peak."""

import json
from copy import deepcopy

import numpy as np
import pytest
from validate import measure, predict
from validation_report import write_report
from validation_science import (
    aperture_diagnostic,
    assess_gates,
    assess_target,
    predict_target,
)


def epochs(snr=20.0):
    return [
        {
            "centroid_px": [10.0, 10.0 + i],
            "predicted_px": [10.0, 10.0 + i],
            "residual_px": 0.0,
            "diagnostic_snr": snr,
        }
        for i in range(2)
    ]


def test_independent_barnard_prediction_preserves_existing_reference():
    for mjd in (60915.637365189206, 61113.31201402778, 61275.607683833325):
        np.testing.assert_allclose(
            predict_target("barnard", mjd), predict(mjd), atol=1e-12, rtol=0
        )


def test_astrometry_gates_do_not_accept_missing_epochs_or_bad_positions():
    manifest = {"bandpass_matched": True}
    assert assess_gates("barnard", manifest, [])["science_status"] == "FAIL"
    good = epochs()
    assert assess_gates("barnard", manifest, good)["science_status"] == "PASS"
    bad = deepcopy(good)
    bad[-1]["centroid_px"][0] += 0.3
    bad[-1]["residual_px"] = 0.3
    assert assess_gates("barnard", manifest, bad)["science_status"] == "FAIL"
    assert (
        assess_gates("eps-ind-b", manifest, epochs(snr=1.0))["science_status"] == "FAIL"
    )
    bad = deepcopy(good)
    for e in bad:
        e["residual_px"] = 0.21
    assert (
        "each_position_within_0_2_px"
        in assess_gates("eps-ind-b", manifest, bad)["failed_gates"]
    )


def test_unverified_wise_never_passes_from_perfect_noise_fits():
    result = assess_gates("wise-0855", {"bandpass_matched": True}, epochs(snr=1000.0))
    assert result["science_status"] == "FAIL"
    assert {
        "reference_verified",
        "independent_detection_significance_calibrated",
        "detected_source_gaia_association_checked",
    } <= set(result["failed_gates"])


@pytest.mark.parametrize("bad", [np.nan, np.inf, -np.inf])
@pytest.mark.parametrize("field", ["centroid_px", "predicted_px", "residual_px"])
def test_nonfinite_middle_epoch_cannot_hide_behind_good_endpoints(bad, field):
    rows = epochs() + [epochs()[1]]
    rows = deepcopy(rows)
    if field == "residual_px":
        rows[1][field] = bad
    else:
        rows[1][field][0] = bad
    for target in ("barnard", "eps-ind-b"):
        result = assess_gates(target, {"bandpass_matched": True}, rows)
        assert result["science_status"] == "FAIL"
        assert result["vector_error_px"] is None
        assert "finite_astrometry_every_epoch" in result["failed_gates"]


@pytest.mark.parametrize("value", [0.0, np.nan])
def test_zero_noise_or_missing_apertures_do_not_become_infinite_snr(value):
    diagnostic = aperture_diagnostic(np.full((59, 59), value), (29.0, 29.0))
    assert diagnostic["diagnostic_snr"] is None
    assert diagnostic["empirical_aperture_noise_mjysr_pixels"] is None


@pytest.mark.parametrize("xy", [(-10, 29), (1, 29), (58, 29), (29, 60), (np.nan, 29)])
def test_truncated_or_outside_aperture_is_not_a_complete_measurement(xy):
    diagnostic = aperture_diagnostic(np.ones((59, 59)), xy)
    assert diagnostic["forced_aperture_sum_mjysr_pixels"] is None
    assert diagnostic["aperture_complete"] is False
    assert diagnostic["diagnostic_snr"] is None


def test_masked_aperture_cannot_acquire_a_positive_snr():
    image = np.ones((59, 59))
    image[29, 29] = np.nan
    diagnostic = aperture_diagnostic(image, (29, 29))
    assert diagnostic["forced_aperture_sum_mjysr_pixels"] is None
    assert diagnostic["aperture_complete"] is False


@pytest.mark.parametrize("noise", [False, True])
def test_weak_wise_is_not_centroided(tmp_path, noise):
    golden = tmp_path / "manifest.json"
    # Identical predicted positions are not the scientific test here: a zero
    # source must be rejected before the Gaussian fitter is even called.
    manifest = {
        "grid": {
            "ny": 59,
            "nx": 59,
            "wcs": {
                "CTYPE1": "RA---TAN",
                "CTYPE2": "DEC--TAN",
                "CRVAL1": 133.7599,
                "CRVAL2": -7.2422,
                "CRPIX1": 30,
                "CRPIX2": 30,
                "CDELT1": -6.15 / 3600,
                "CDELT2": 6.15 / 3600,
            },
        },
        "epochs": [
            {
                "image": "e0.f32",
                "t_mean_mjd": 61159.3,
                "n_frames": 3,
                "lambda_um": [4.5, 5.0],
            }
        ],
        "frames": [1, 2, 3],
        "render_key": "test",
        "bandpass_matched": False,
    }
    golden.write_text(json.dumps(manifest))
    image = (
        np.random.default_rng(17).normal(0, 1, (59, 59))
        if noise
        else np.zeros((59, 59))
    )
    image.astype("<f4").tofile(tmp_path / "e0.f32")

    def forbidden(*args):
        pytest.fail("A zero-noise patch must not be centroided into a detection")

    result = assess_target("wise-0855", manifest, tmp_path, forbidden)
    assert result["assessment_complete"] and result["science_status"] == "FAIL"
    assert "centroid_px" not in result["epochs"][0]
    if not noise:
        assert result["epochs"][0]["forced_aperture_sum_mjysr_pixels"] == 0.0
    else:
        assert result["epochs"][0]["diagnostic_snr"] < 5


def test_variable_raw_flux_change_cannot_pass_missing_photometry_gates():
    for target in ("rw-aur", "r-dra"):
        rows = epochs()
        rows[0]["aperture_sum_mjysr"] = 10.0
        rows[1]["aperture_sum_mjysr"] = 1000.0
        result = assess_gates(target, {"bandpass_matched": True}, rows)
        assert result["science_status"] == "FAIL"
        assert "comparison_star_calibration_floor_established" in result["failed_gates"]


def test_gaussian_fitter_rejects_all_masked_data():
    with pytest.raises(ValueError, match="not enough valid pixels"):
        measure(np.full((31, 31), np.nan), (15, 15))


def test_report_preserves_capture_history_and_updates_real_status_column(tmp_path):
    (tmp_path / "docs/validation").mkdir(parents=True)
    (tmp_path / "validation.md").write_text(
        "old\n## Capture recovery\nHistorical receipt stays exact.\n"
    )
    (tmp_path / "docs/TARGETS.md").write_text(
        "| WISE 0855 | motion | 1 | 2 | not tested | Original reference. |\n"
    )
    report = {
        "epochs": [],
        "frames": 0,
        "science_status": "FAIL",
        "failed_gates": ["reference_verified"],
    }
    write_report(tmp_path, {"pipeline_version": 3, "reports": {"wise-0855": report}})
    assert (
        "## Capture recovery\nHistorical receipt stays exact."
        in (tmp_path / "validation.md").read_text()
    )
    target = (tmp_path / "docs/TARGETS.md").read_text()
    assert "| 2 | FAIL |" in target and "Original reference." in target
