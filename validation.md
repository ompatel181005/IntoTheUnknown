# Real-data validation

## Current React + FastAPI app

Validated 2026-11-14 after integrating main's field-star scaling change (#45), pipeline version 2. The default Barnard preset uses B1-B2 and a 6 arcmin field. The actual backend stacks are exported as static golden snapshots; array hashes are checked against the fresh backend output and the production frontend build before the browser test.

| Barnard measurement | Result | Criterion |
|---|---:|---:|
| First-to-last centroid shift | 1.6425 px | Compare with Gaia prediction |
| Gaia proper motion + parallax prediction | 1.6687 px | Independent Astropy calculation |
| Motion-vector error | **0.0410 px, PASS** | At most 0.2 px |
| Largest per-epoch positional residual | **0.1704 px, PASS** | Less than 0.3 px |
| Epochs / input cutouts | 3 / 115 | 37, 36 and 42 cutouts |
| Common channel set across epochs | Matched | Required for this result |

Dense saved captures now use the same ten-frame epoch floor as live data when at least two epochs reach that floor. Barnard's five-frame and one-frame tails are excluded. Including the thin five-frame tail reduced the channel intersection and failed the motion gate at 0.2765 px; this is why the selection rule changes. Sparse legacy demo packs retain their existing two-frame fallback and receive no new science claim.

All five production React presets render with **every API request returning HTTP 503**, and with external browser requests blocked. This tests API-independent snapshots while the web host stays reachable; host outages and cold starts are outside this check. With the API available, the React spectrum panel receives 37 points and the brightness panel receives 115 points for Barnard. Golden render IDs are resolved to backend view IDs only when measurements are requested. No archive traffic is needed for these saved views.

| Preset | Epochs | Cutouts in bundled view | Browser with API down | Science |
|---|---:|---:|---|---|
| Barnard | 3 | 115 | PASS | Astrometry PASS |
| epsilon Indi B | 4 | 62 | PASS | Not validated |
| WISE 0855 | 3 | 9 | PASS | Not validated |
| RW Aur | 3 | 52 | PASS | Not validated |
| R Dra | 9 | 18 | PASS | Not validated |

The independent reference uses Gaia DR3 J2016.0 astrometry, Astropy space motion and Earth's barycentric position, without aberration. A 7 by 7 Gaussian fit measures observed pixels near the prediction. Barnard is saturated: aperture sums are not calibrated photometry. Field-star alignment scatter, variability calibration, faint-source detection and discovery sensitivity remain unvalidated. RW Aur's field-star scale warning (about 0.925 in one epoch) remains a calibration concern; it is not a variability detection.

Evidence: [measurements and array hashes](docs/validation/integrated.json), [React screenshot](docs/validation/react-barnard.png). Historical prototype measurements and max-per settings are retained in [legacy-browser.md](docs/validation/legacy-browser.md); those settings do not describe the current React UI.

## Reproduce

Install the backend development dependencies plus scipy and playwright; use installed Chrome or Chromium. Raw data stays outside Git. Build the frontend between exporting snapshots and testing the browser:

```powershell
python scripts/validate_integrated.py --export-golden
npm.cmd --prefix frontend ci
npm.cmd --prefix frontend run build
python scripts/validate_integrated.py --chrome '<Chrome executable>'
python -m pytest -q scripts/tests/test_capture_validation.py
```

The runner uses the real FastAPI build function and production frontend. It blocks archive access during saved renders, checks static arrays byte-for-byte, tests both measurement panels, and then denies all API requests for the five preset loads. It exits nonzero for a Barnard science failure, stale snapshots, empty measurements, missing canvases, browser errors or external requests. Detailed output is under ignored `scripts/spike_out/integrated/`.

## Capture recovery

The original capture log is historical. Each local `frames.csv` and `retry-report.json` records current recovery state: Barnard 121, epsilon Indi B 189, WISE 0855 93, RW Aur 335 and R Dra 337 successful cutouts, totaling **1,075 with zero failures**. All seven failed requests were recovered. Only Barnard's richer B1-B2 capture has been packed and science-validated here; the other displayed packs remain smaller existing demo inputs.

The FITS packer subtracts ZODI once and preserves WCS and named FLAGS. Barnard's demo folder retains 36 longer-wavelength cutouts in addition to the 121 new B1-B2 files. Recovery uses bounded cutout requests, validates FITS shapes, and updates CSV manifests atomically; no full frames are requested. Commands for rebuilding from local raw captures:

```powershell
python scripts/retry_capture.py --capture-root D:/spherex_golden
python scripts/pack_capture.py --capture-root D:/spherex_golden --only barnard
```
