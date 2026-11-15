"""Validate the current five saved targets, with no archive access.

Requires numpy, scipy, astropy and playwright; uses an installed Chrome/Chromium browser.
python scripts/validate.py --chrome "C:/Program Files/Google/Chrome/Application/chrome.exe"
"""

import argparse
import csv
import functools
import hashlib
import json
import threading
from datetime import UTC, datetime
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

import astropy.units as u
import numpy as np
from astropy.coordinates import Distance, SkyCoord, get_body_barycentric
from astropy.time import Time
from astropy.utils import iers
from playwright.sync_api import sync_playwright
from scipy.optimize import least_squares

ROOT = Path(__file__).resolve().parents[1]
iers.conf.auto_download = False


def predict(mjd):
    """Independent Gaia DR3 J2016.0 space motion + Earth parallax, without aberration.

    Radial velocity is zero here; perspective acceleration is below this test's 0.2 px tolerance.
    """
    source = SkyCoord(
        ra=269.448503 * u.deg,
        dec=4.739420 * u.deg,
        pm_ra_cosdec=-801.6 * u.mas / u.yr,
        pm_dec=10362.4 * u.mas / u.yr,
        distance=Distance(parallax=546.98 * u.mas),
        radial_velocity=0 * u.km / u.s,
        obstime=Time(2016.0, format="jyear", scale="tcb"),
    )
    t = Time(mjd, format="mjd", scale="utc")
    moved = source.apply_space_motion(new_obstime=t)
    a, d = moved.ra.rad, moved.dec.rad
    x, y, z = get_body_barycentric("earth", t).xyz.to_value(u.au)
    da = 546.98 * (x * np.sin(a) - y * np.cos(a)) / (3.6e6 * np.cos(d))
    dd = (
        546.98
        * (x * np.cos(a) * np.sin(d) + y * np.sin(a) * np.sin(d) - z * np.cos(d))
        / 3.6e6
    )
    return [float(moved.ra.deg + da), float(moved.dec.deg + dd)]


def measure(image, expected):
    """Fit the observed 7x7 patch; the prediction chooses a search window, not a centroid."""
    x, y = expected
    ix, iy = round(x), round(y)
    patch = image[iy - 3 : iy + 4, ix - 3 : ix + 4]
    if patch.shape != (7, 7) or np.isfinite(patch).sum() < 25:
        raise ValueError("not enough valid pixels around target")
    yy, xx = np.indices(patch.shape)
    valid = np.isfinite(patch)
    sky = float(np.nanmedian(patch))
    amp = float(np.nanmax(patch) - sky)
    if amp <= 0:
        raise ValueError("no positive source in search window")

    def residual(p):
        height, cx, cy, sx, sy, background = p
        model = background + height * np.exp(
            -0.5 * (((xx - cx) / sx) ** 2 + ((yy - cy) / sy) ** 2)
        )
        return (model - patch)[valid]

    fit = least_squares(
        residual,
        [amp, 3, 3, 1, 1, sky],
        bounds=([0, 0.5, 0.5, 0.3, 0.3, -np.inf], [np.inf, 5.5, 5.5, 3, 3, np.inf]),
    )
    if not fit.success:
        raise ValueError("centroid fit failed")
    cx, cy = ix - 3 + fit.x[1], iy - 3 + fit.x[2]
    gy, gx = np.indices(image.shape)
    radius = np.hypot(gx - cx, gy - cy)
    annulus = image[(radius >= 4) & (radius <= 7)]
    flux = float(np.nansum(image[radius <= 2.2] - np.nanmedian(annulus)))
    return {
        "centroid_px": [float(cx), float(cy)],
        "residual_px": float(np.hypot(cx - x, cy - y)),
        "aperture_sum_mjysr": flux,
    }


class LocalAssets(SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_GET(self):
        path = urlsplit(self.path).path
        if path not in ("/", "/index.html") and not path.startswith("/demo/"):
            self.send_error(404)
            return
        super().do_GET()


def browser_frames(chrome, out, max_per):
    server = ThreadingHTTPServer(
        ("127.0.0.1", 0), functools.partial(LocalAssets, directory=str(ROOT))
    )
    server.request_queue_size = 128
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    errors, archive_requests = [], []
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(
                executable_path=str(chrome), headless=True
            )
            page = browser.new_page(
                viewport={"width": 1400, "height": 1000}, reduced_motion="reduce"
            )

            def route_request(route):
                url = route.request.url
                if (
                    urlsplit(url).hostname not in ("127.0.0.1", "localhost")
                    or "/proxy/" in url
                ):
                    archive_requests.append(url)
                    route.abort()
                else:
                    route.continue_()

            page.route("**/*", route_request)
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.add_init_script("localStorage.setItem('blinkTourDone','1')")
            page.goto(f"http://127.0.0.1:{server.server_port}/index.html?src=demo")
            page.wait_for_function(
                "typeof S !== 'undefined' && !S.loading && S.exps.length > 0",
                timeout=90000,
            )
            # Exercise the full captured B1-B2 set, not the viewer's default 3-per-detector subsample.
            page.evaluate(
                "async per => { $('maxPer').value=per; S.group='epoch'; S.disp='gray'; S.comb='median'; S.dets=new Set([1,2]); await load(); }",
                max_per,
            )
            page.wait_for_function("!S.loading && S.exps.length > 0", timeout=90000)
            result = page.evaluate("""() => ({n:S.N, centre:S.center, pix_arcsec:CONFIG.PIX_ARCSEC,
              exposures:S.exps.length, badge:$('modeBadge').textContent,
              wavelength_failures:S.exps.filter(e=>e.lamSrc!=='WCS-WAVE'||!(e.lam>=DETS[e.det-1].lo-0.05&&e.lam<=DETS[e.det-1].hi+0.05)).length,
              frames:S.frames.map(f=>({mjd:yearToMjd(f.year), n_frames:f.exps.length, image:Array.from(f.img),
                mjds:f.exps.map(e=>e.mjd), wavelengths:f.exps.map(e=>e.lam)}))})""")
            expected = [predict(f["mjd"]) for f in result["frames"]]
            result["predicted_px"] = page.evaluate(
                "positions => positions.map(p=>skyToGrid(...p))", expected
            )
            result["expected_exposures"] = page.evaluate(
                "async () => pickSubset((await queryDemo('barnard')).rows, +$('maxPer').value).length"
            )
            page.evaluate("() => { S.cur=0; render(); }")
            page.screenshot(path=str(out / "barnard-first.png"))
            page.evaluate(
                "() => { S.cur=S.frames.length-1; S.ref='first'; S.refIdx=0; setDisp('diff'); }"
            )
            page.screenshot(path=str(out / "barnard-difference.png"))
            browser.close()
            result["browser_errors"] = errors
            result["archive_requests"] = archive_requests
            return result
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def legacy_main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--chrome", type=Path)
    parser.add_argument(
        "--capture-root",
        type=Path,
        help="optional raw capture directory for the summary inventory",
    )
    parser.add_argument(
        "--summarize",
        type=Path,
        help="combine existing browser run results under this directory, without launching Chrome",
    )
    parser.add_argument(
        "--max-per",
        type=int,
        default=40,
        help="40 checks the full Barnard capture; 3 checks normal UI selection",
    )
    parser.add_argument(
        "--out", type=Path, default=ROOT / "scripts/spike_out/browser-validation"
    )
    parser.add_argument("--report", type=Path, default=ROOT / "validation.md")
    args = parser.parse_args()
    if args.summarize:
        summarize(args.summarize, args.report, args.capture_root)
        return 0
    if args.chrome is None:
        parser.error("--chrome is required unless --summarize is used")
    args.out.mkdir(parents=True, exist_ok=True)
    data = browser_frames(args.chrome, args.out, args.max_per)
    data["max_per_detector_per_season"] = args.max_per
    data["loaded_exposures"] = data["exposures"]
    data["exposures"] = sum(frame["n_frames"] for frame in data["frames"])
    epochs = []
    for frame, prediction in zip(data["frames"], data.pop("predicted_px"), strict=True):
        image = np.asarray(frame.pop("image"), dtype=float).reshape(
            data["n"], data["n"]
        )
        measured = measure(image, prediction)
        epochs.append({**frame, **measured, "predicted_px": prediction})
    measured_shift = np.subtract(epochs[-1]["centroid_px"], epochs[0]["centroid_px"])
    predicted_shift = np.subtract(epochs[-1]["predicted_px"], epochs[0]["predicted_px"])
    error = float(np.linalg.norm(measured_shift - predicted_shift))
    passed = (
        len(epochs) >= 2
        and error <= 0.2
        and max(e["residual_px"] for e in epochs) < 0.3
        and data["wavelength_failures"] == 0
        and data["loaded_exposures"] == data["expected_exposures"]
        and not data["browser_errors"]
        and not data["archive_requests"]
    )
    data.update(
        epochs=epochs,
        shift_measured_px=float(np.linalg.norm(measured_shift)),
        shift_predicted_px=float(np.linalg.norm(predicted_shift)),
        shift_error_px=error,
        astrometry_pass=bool(passed),
    )
    data.pop("frames")
    (args.out / "results.json").write_text(
        json.dumps(data, indent=2, allow_nan=False) + "\n", encoding="utf8"
    )
    lines = [
        "# Real-data validation",
        "",
        f"Generated {datetime.now(UTC).isoformat()} by `scripts/validate.py`.",
        "",
        f"## Barnard's Star: adopted app, B1-B2 pack, max-per={args.max_per}",
        "",
        f"**Astrometry: {'PASS' if passed else 'FAIL'}.** {data['exposures']} real cutouts, {len(epochs)} displayed epochs; archive access blocked during the browser test.",
        "",
        "| Epoch mean MJD | Frames | Centroid x,y (px) | Gaia residual (px) |",
        "|---|---:|---|---:|",
    ]
    for e in epochs:
        x, y = e["centroid_px"]
        lines.append(
            f"| {e['mjd']:.5f} | {e['n_frames']} | {x:.3f}, {y:.3f} | {e['residual_px']:.3f} |"
        )
    lines += [
        "",
        f"First-to-last shift: measured **{data['shift_measured_px']:.3f} px**, Gaia **{data['shift_predicted_px']:.3f} px**, vector error **{error:.3f} px** (limit 0.2 px).",
        "",
        "This tests actual browser reprojection and median stacks. The Gaia reference uses Astropy space motion and Earth's barycentric position, independently of the viewer's approximate ephemeris. No synthetic exposures are used. The search window is chosen by Gaia, while the Gaussian centroid is fitted to observed pixels.",
        "",
        "**Limits:** bright-star saturation prevents interpreting aperture sums as calibrated photometry. The viewer combines unmatched wavelength samples; this result does not establish matched-band variability or discovery sensitivity. WISE 0855, epsilon Indi B and both variables remain unvalidated by this report. Default 3-per-detector selection is a separate check from the full-capture test.",
        "",
        "Screenshots and detailed results are generated under the chosen `--out` directory (ignored by Git by default).",
    ]
    args.report.write_text("\n".join(lines) + "\n", encoding="utf8")
    print(
        json.dumps(
            {
                k: data[k]
                for k in [
                    "exposures",
                    "shift_measured_px",
                    "shift_predicted_px",
                    "shift_error_px",
                    "astrometry_pass",
                    "browser_errors",
                    "archive_requests",
                ]
            },
            indent=2,
        )
    )
    return 0 if passed else 1


def summarize(results_dir, report_path, capture_root=None):
    runs = {}
    for path in results_dir.glob("*/results.json"):
        result = json.loads(path.read_text(encoding="utf8"))
        setting = result.get("max_per_detector_per_season")
        if setting in (3, 10, 40):
            runs[setting] = result
    if set(runs) != {3, 10, 40}:
        raise ValueError("summary needs results for max-per 3, 10 and 40")
    if runs[3]["astrometry_pass"] or not all(
        runs[k]["astrometry_pass"] for k in (10, 40)
    ):
        raise ValueError(
            "observed outcomes differ from this report's recommendation; review the measurements"
        )
    manifest = json.loads(
        (ROOT / "demo/barnard/manifest.json").read_text(encoding="utf8")
    )
    provenance = {
        "app_sha256": hashlib.sha256((ROOT / "index.html").read_bytes()).hexdigest(),
        "manifest_sha256": hashlib.sha256(
            (ROOT / "demo/barnard/manifest.json").read_bytes()
        ).hexdigest(),
        "runs": runs,
    }
    if capture_root:
        inventory = {}
        for path in sorted(capture_root.glob("*/frames.csv")):
            with path.open(newline="", encoding="utf8") as stream:
                rows = list(csv.DictReader(stream))
            inventory[path.parent.name] = {
                "successful": sum(r["status"] in ("ok", "skip") for r in rows),
                "failed": sum(r["status"] == "fail" for r in rows),
            }
        provenance["capture_inventory"] = inventory
        provenance["recovery_receipt"] = json.loads(
            (capture_root / "retry-report.json").read_text(encoding="utf8")
        )
    evidence_dir = ROOT / "docs/validation"
    evidence_dir.mkdir(exist_ok=True)
    (evidence_dir / "barnard.json").write_text(
        json.dumps(provenance, indent=2, allow_nan=False) + "\n", encoding="utf8"
    )
    lines = [
        "# Real-data validation",
        "",
        "## Barnard's Star in the adopted app",
        "",
        f"The pack contains {manifest.get('captured_files', len(manifest['files']))} new B1-B2 cutouts plus {manifest.get('retained_other_band_files', 0)} retained longer-wavelength cutouts, totaling {sum(f['bytes'] for f in manifest['files']) / 1e6:.2f} MB. The adopted FITS packer subtracts ZODI once and retains WCS and named FLAGS. All three tests use **D1 and D2 only** for the displayed stacks, with archive access blocked. Other bands remain available but are not part of this astrometry result.",
        "",
        "| Images per detector per season | Loaded cutouts | Measured shift (px) | Gaia shift (px) | Vector error (px) | Astrometry |",
        "|---:|---:|---:|---:|---:|---|",
    ]
    for setting, result in sorted(runs.items()):
        lines.append(
            f"| {setting} | {result['exposures']} | {result['shift_measured_px']:.3f} | {result['shift_predicted_px']:.3f} | {result['shift_error_px']:.3f} | {'PASS' if result['astrometry_pass'] else 'FAIL'} |"
        )
    lines += [
        "",
        "**Use Demo mode, select only D1 and D2, set Advanced → Images per detector per visit = 10, then reload Barnard.** This tested setting meets the ±0.2 px motion-vector and <0.3 px per-epoch residual criteria. With D1-D2, the normal setting of 3 fails the motion-vector criterion; do not quote it as a science pass. The UI default was not changed in this data-only PR.",
        "",
        "The independent reference uses Gaia DR3 J2016.0 astrometry, Astropy space motion and Earth's barycentric position, with no aberration. A 7×7 Gaussian fit measures observed pixels near the prediction. Aperture sums are recorded in the JSON but are not calibrated photometry: Barnard is saturated. Channel matching, field-star alignment scatter, WISE 0855 detection, epsilon Indi B and both variable targets remain unvalidated. A passing Barnard motion test does not establish variability or discovery sensitivity.",
        "",
        "## Reproduce",
        "",
        "Dependencies: Python 3.11, numpy, astropy, scipy, playwright, pytest and ruff; installed Chrome or Chromium. The packer reuses `tools/fetch_demo.py`. Raw data stays outside Git.",
        "",
        "```powershell",
        "python scripts/retry_capture.py --capture-root D:/spherex_golden",
        "python scripts/pack_capture.py --capture-root D:/spherex_golden --only barnard",
        "python scripts/validate.py --chrome '<Chrome executable>' --max-per 3 --out scripts/spike_out/browser-default --report scripts/spike_out/browser-default/report.md",
        "python scripts/validate.py --chrome '<Chrome executable>' --max-per 10 --out scripts/spike_out/browser-10 --report scripts/spike_out/browser-10/report.md",
        "python scripts/validate.py --chrome '<Chrome executable>' --max-per 40 --out scripts/spike_out/browser-40 --report scripts/spike_out/browser-40/report.md",
        "python scripts/validate.py --summarize scripts/spike_out --capture-root D:/spherex_golden --report validation.md",
        "python -m pytest -q scripts/tests/test_capture_validation.py",
        "```",
        "",
        "The max-per=3 command intentionally exits 1 for the observed science failure. Detailed measurements and input hashes (recorded at summary generation) are in [docs/validation/barnard.json](docs/validation/barnard.json). Screenshots: [first epoch](docs/validation/barnard-first.png), [first-to-last difference](docs/validation/barnard-difference.png).",
        "",
        "## Capture recovery",
        "",
        "The original capture log is historical; current state is in each frames.csv and retry-report.json. Recovery validates the recovered image/FLAGS/VARIANCE/ZODI shapes and updates the local CSV manifests atomically; no full frames are requested.",
    ]
    if capture_root:
        lines += ["", "| Target | Successful cutouts | Failed |", "|---|---:|---:|"]
        for name, counts in inventory.items():
            lines.append(f"| {name} | {counts['successful']} | {counts['failed']} |")
        recovered = sum(x["recovered"] for x in provenance["recovery_receipt"].values())
        lines += [
            "",
            f"Most recent recovery receipt: **{recovered}** recovered requests. Inventory and receipt are preserved in the JSON evidence.",
        ]
    report_path.write_text("\n".join(lines) + "\n", encoding="utf8")
    print(
        f"Wrote {report_path}; default selection FAIL, recommended 10 and full capture PASS"
    )


def main():
    import sys

    if "--legacy" in sys.argv:
        sys.argv.remove("--legacy")
        return legacy_main()
    from validate_integrated import main as integrated_main

    return integrated_main()


if __name__ == "__main__":
    raise SystemExit(main())
