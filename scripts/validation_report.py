"""Explicitly publish current validation evidence without replacing recovery history."""

import json
import shutil
from datetime import UTC, datetime

from validation_science import NAMES


def write_report(root, evidence, screenshot=None):
    reports = evidence["reports"]
    generated = datetime.now(UTC).isoformat()
    lines = [
        "# Real-data validation",
        "",
        "## Current React + FastAPI app",
        "",
        f"Generated {generated}; pipeline version **{evidence['pipeline_version']}**.",
        "",
        (
            "All five targets were assessed against the actual saved epoch MJDs and rendered float arrays. "
            "A FAIL is a failed science criterion or an unmet validation prerequisite, not a failed web application. "
            "No new astronomy data was downloaded."
        ),
        "",
        "| Target | Epochs | Cutouts | Science gate | Failed criteria |",
        "|---|---:|---:|---|---|",
    ]
    for target, report in reports.items():
        lines.append(
            f"| {NAMES[target]} | {len(report['epochs'])} | {report['frames']} | **{report['science_status']}** | "
            + (", ".join(report["failed_gates"]).replace("_", " ") or "None")
            + " |"
        )
    lines += [
        "",
        "### Measurement method and limits",
        "",
        (
            "Validation predicts positions independently of the production Gaia predictor: pinned catalogue values, "
            "Astropy space motion, and first-order Earth parallax using the offline built-in ephemeris. "
            "Radial velocity is set to zero. Predictions select a search window; they do not set fitted centroids. "
            "Gaia references use J2016.0 TCB. WISE's CatWISE position uses MJD 57170 TDB, while its motion and "
            "parallax remain unverified literature values."
        ),
        "",
        (
            "A Gaussian fit uses the observed 7×7 patch. Forced aperture sums use radius 2.2 pixels and a 4–7 pixel "
            "background annulus. Their units are MJy/sr × pixels, not calibrated source flux. Noise is the clipped "
            "scatter of same-size apertures on a fixed background grid, retaining resampling correlations. "
            "This empirical S/N is diagnostic: there is no injection/recovery or false-positive calibration. "
            "Missing, masked or zero-noise apertures have null S/N; they cannot pass a detection gate."
        ),
        "",
        (
            "Barnard retains its established ≤0.2 px motion-vector error and <0.3 px per-epoch residual gates, "
            "with matched channels. Its bright saturated image is useful for astrometry, not calibrated photometry. "
            "Epsilon applies the documented ≤0.2 px position criterion, ≤0.2 px vector error, and a conservative "
            "diagnostic S/N check in every epoch. Binary blending can also affect its photocentre."
        ),
        "",
        (
            "WISE: **no validated detection in these bundled observations**. A noise-patch fit is not a detection. "
            "Centroids are not fitted below diagnostic S/N 5. Even an above-threshold aperture cannot establish "
            "the required detection without a verified reference, calibrated significance and a Gaia association "
            "check on a detected source. This does not establish the object's physical absence."
        ),
        "",
        (
            "RW Aur and R Dra: rendered broad-band aperture sums do not meet the requested per-band, "
            "unsaturated light-curve/error and comparison-star calibration gates. R Dra additionally lacks matched "
            "stack channels and an independently verified period/phase assessment. Raw brightness range is not "
            "a validated variability detection. No direction of RW Aur variability is assumed."
        ),
        "",
    ]
    for target, report in reports.items():
        lines += [
            f"### {NAMES[target]}: {report['science_status']}",
            "",
            "| Mean MJD | Cutouts | Predicted x,y (px) | Fitted x,y (px) | Residual (px) | Forced aperture sum | Empirical S/N |",
            "|---:|---:|---|---|---:|---:|---:|",
        ]
        for e in report["epochs"]:
            fmt = lambda value: (
                f"{value:.4f}" if value is not None else "not established"
            )
            xy = lambda value: (
                ", ".join(f"{x:.3f}" for x in value)
                if value is not None
                else "not fitted"
            )
            lines.append(
                f"| {e['mjd']:.5f} | {e['n_frames']} | {xy(e['predicted_px'])} | {xy(e.get('centroid_px'))} | "
                f"{fmt(e.get('residual_px'))} | {fmt(e['forced_aperture_sum_mjysr_pixels'])} | {fmt(e['diagnostic_snr'])} |"
            )
        if report.get("vector_error_px") is not None:
            lines += [
                "",
                f"First-to-last motion-vector error: **{report['vector_error_px']:.4f} px**.",
            ]
        if report.get("not_established_by_this_assessment"):
            lines += [
                "",
                "Not established by this assessment: "
                + ", ".join(report["not_established_by_this_assessment"]).replace(
                    "_", " "
                )
                + ". These are unmet validation prerequisites, not evidence of physical absence or constancy.",
            ]
        lines += [
            "",
            "Failed gates: "
            + (", ".join(report["failed_gates"]).replace("_", " ") or "none")
            + ".",
            "",
        ]
    lines += [
        "## Software and snapshot checks",
        "",
        (
            "All render arrays and referenced sidecars are checked byte-for-byte against the fresh backend output. "
            "The production browser check requires all five saved presets to render while API requests are denied. "
            "Barnard's spectrum and brightness endpoints must also return measurements with the API available. "
            "These checks establish reproducibility and wiring, not a science pass for every target."
        ),
        "",
        (
            f"Browser verification performed: **{bool(evidence.get('browser_verified'))}**. "
            f"Browser errors: {len(evidence.get('browser_errors', []))}; "
            f"external requests: {len(evidence.get('external_requests', []))}."
        ),
        "",
        (
            "Evidence: [current metrics and hashes](docs/validation/integrated.json), "
            "[current React screenshot](docs/validation/react-barnard.png). Historical prototype evidence: "
            "[legacy-browser.md](docs/validation/legacy-browser.md)."
        ),
        "",
        "## Reproduce",
        "",
        "```powershell",
        "$env:STORAGE_ACCOUNT_URL=''; $env:APPLICATIONINSIGHTS_CONNECTION_STRING=''",
        "python scripts/validate.py --export-golden",
        "npm.cmd --prefix frontend run build",
        "python scripts/validate.py --chrome '<Chrome executable>' --write-report",
        "python -m pytest -q scripts/tests",
        "```",
        "",
        (
            "The default entry runs current integrated validation; `--legacy` explicitly selects the historical "
            "prototype runner. Expected science FAIL results are recorded rather than hidden. The normal exit "
            "code still requires Barnard PASS and successful software checks. `--write-report` additionally "
            "requires the current browser verification before publishing evidence."
        ),
        "",
    ]
    old = (root / "validation.md").read_text(encoding="utf8")
    # Recovery statements are historical provenance, not recreated from today's
    # smaller bundled packs or inferred from directory counts.
    if "## Capture recovery" in old:
        lines += [old[old.index("## Capture recovery") :].rstrip(), ""]
    (root / "validation.md").write_text("\n".join(lines), encoding="utf8")
    (root / "docs/validation/integrated.json").write_text(
        json.dumps(evidence, indent=2, allow_nan=False) + "\n", encoding="utf8"
    )
    if screenshot:
        shutil.copyfile(screenshot, root / "docs/validation/react-barnard.png")
    path = root / "docs/TARGETS.md"
    text = path.read_text(encoding="utf8")
    labels = {
        "Barnard's Star": "barnard",
        "ε Ind B": "eps-ind-b",
        "WISE 0855": "wise-0855",
        "RW Aur": "rw-aur",
        "R Dra": "r-dra",
    }
    rows = []
    for line in text.splitlines():
        cells = line.split("|")
        if len(cells) == 8 and cells[1].strip() in labels:
            report = reports[labels[cells[1].strip()]]
            cells[5] = f" {report['science_status']} "
            note = cells[6].strip()
            prefix = "Current saved-product assessment; see validation.md. "
            cells[6] = " " + (note if note.startswith(prefix) else prefix + note) + " "
            line = "|".join(cells)
        rows.append(line)
    path.write_text("\n".join(rows) + "\n", encoding="utf8")
