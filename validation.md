# Real-data validation

## Current React + FastAPI app

Generated 2026-11-15T06:37:33.142420+00:00; pipeline version **3**.

All five targets were assessed against the actual saved epoch MJDs and rendered float arrays. A FAIL is a failed science criterion or an unmet validation prerequisite, not a failed web application. No new astronomy data was downloaded.

| Target | Epochs | Cutouts | Science gate | Failed criteria |
|---|---:|---:|---|---|
| Barnard's Star | 3 | 115 | **PASS** | None |
| epsilon Indi B | 4 | 148 | **PASS** | None |
| WISE 0855 | 3 | 9 | **FAIL** | reference verified, centroids available, finite astrometry every epoch, vector error within limit, at least two diagnostic snr 5 epochs, independent detection significance calibrated, detected source gaia association checked, matched wavelength channels |
| RW Aur | 3 | 52 | **FAIL** | per band fluxes with validated errors, target saturation checked per input, comparison star calibration floor established |
| R Dra | 9 | 18 | **FAIL** | matched wavelength channels, per band fluxes with validated errors, target saturation checked per input, comparison star calibration floor established, amplitude above 20 percent and comparison floor, independently verified period and phase |

### Measurement method and limits

Validation predicts positions independently of the production Gaia predictor: pinned catalogue values, Astropy space motion, and first-order Earth parallax using the offline built-in ephemeris. Radial velocity is set to zero. Predictions select a search window; they do not set fitted centroids. Gaia references use J2016.0 TCB. WISE's CatWISE position uses MJD 57170 TDB, while its motion and parallax remain unverified literature values.

A Gaussian fit uses the observed 7×7 patch. Forced aperture sums use radius 2.2 pixels and a 4–7 pixel background annulus. Their units are MJy/sr × pixels, not calibrated source flux. Noise is the clipped scatter of same-size apertures on a fixed background grid, retaining resampling correlations. This empirical S/N is diagnostic: there is no injection/recovery or false-positive calibration. Missing, masked or zero-noise apertures have null S/N; they cannot pass a detection gate.

Barnard retains its established ≤0.2 px motion-vector error and <0.3 px per-epoch residual gates, with matched channels. Its bright saturated image is useful for astrometry, not calibrated photometry. Epsilon applies the documented ≤0.2 px position criterion, ≤0.2 px vector error, and a conservative diagnostic S/N check in every epoch. Binary blending can also affect its photocentre.

WISE: **no validated detection in these bundled observations**. A noise-patch fit is not a detection. Centroids are not fitted below diagnostic S/N 5. Even an above-threshold aperture cannot establish the required detection without a verified reference, calibrated significance and a Gaia association check on a detected source. This does not establish the object's physical absence.

RW Aur and R Dra: rendered broad-band aperture sums do not meet the requested per-band, unsaturated light-curve/error and comparison-star calibration gates. R Dra additionally lacks matched stack channels and an independently verified period/phase assessment. Raw brightness range is not a validated variability detection. No direction of RW Aur variability is assumed.

### Barnard's Star: PASS

| Mean MJD | Cutouts | Predicted x,y (px) | Fitted x,y (px) | Residual (px) | Forced aperture sum | Empirical S/N |
|---:|---:|---|---|---:|---:|---:|
| 60915.63737 | 37 | 29.038, 28.442 | 28.901, 28.479 | 0.1415 | 7025.5190 | 8351.0888 |
| 61113.31201 | 36 | 28.938, 29.332 | 29.002, 29.181 | 0.1632 | 7624.4883 | 9100.1964 |
| 61275.60768 | 42 | 29.163, 30.106 | 28.993, 30.119 | 0.1704 | not established | not established |

First-to-last motion-vector error: **0.0410 px**.

Failed gates: none.

### epsilon Indi B: PASS

| Mean MJD | Cutouts | Predicted x,y (px) | Fitted x,y (px) | Residual (px) | Forced aperture sum | Empirical S/N |
|---:|---:|---|---|---:|---:|---:|
| 60794.26093 | 30 | 29.397, 29.290 | 29.296, 29.181 | 0.1488 | 18.7924 | 132.4622 |
| 60955.58955 | 43 | 29.179, 29.063 | 29.171, 28.908 | 0.1546 | 16.7253 | 98.4327 |
| 61155.88719 | 44 | 28.757, 28.895 | 28.641, 28.827 | 0.1346 | 17.9686 | 111.5683 |
| 61311.39905 | 31 | 28.544, 28.670 | 28.458, 28.534 | 0.1606 | 22.2548 | 180.2417 |

First-to-last motion-vector error: **0.0308 px**.

Failed gates: none.

### WISE 0855: FAIL

| Mean MJD | Cutouts | Predicted x,y (px) | Fitted x,y (px) | Residual (px) | Forced aperture sum | Empirical S/N |
|---:|---:|---|---|---:|---:|---:|
| 60800.74533 | 3 | 28.244, 28.867 | not fitted | not established | 0.3843 | 2.0337 |
| 60992.24034 | 3 | 28.800, 28.882 | not fitted | not established | 0.6572 | 4.0717 |
| 61159.34568 | 3 | 29.540, 28.972 | not fitted | not established | 0.5946 | 4.3192 |

Not established by this assessment: reference verified, independent detection significance calibrated, detected source gaia association checked. These are unmet validation prerequisites, not evidence of physical absence or constancy.

Failed gates: reference verified, centroids available, finite astrometry every epoch, vector error within limit, at least two diagnostic snr 5 epochs, independent detection significance calibrated, detected source gaia association checked, matched wavelength channels.

### RW Aur: FAIL

| Mean MJD | Cutouts | Predicted x,y (px) | Fitted x,y (px) | Residual (px) | Forced aperture sum | Empirical S/N |
|---:|---:|---|---|---:|---:|---:|
| 60928.24012 | 17 | 28.994, 29.001 | 28.699, 29.061 | 0.3018 | 1588.3842 | 3425.8188 |
| 61103.08000 | 17 | 28.996, 28.998 | 28.752, 29.035 | 0.2471 | 1425.7841 | 3589.4964 |
| 61294.54285 | 18 | 28.994, 28.996 | 28.824, 29.031 | 0.1730 | 983.0298 | 2349.3219 |

First-to-last motion-vector error: **0.1289 px**.

Not established by this assessment: per band fluxes with validated errors, target saturation checked per input, comparison star calibration floor established. These are unmet validation prerequisites, not evidence of physical absence or constancy.

Failed gates: per band fluxes with validated errors, target saturation checked per input, comparison star calibration floor established.

### R Dra: FAIL

| Mean MJD | Cutouts | Predicted x,y (px) | Fitted x,y (px) | Residual (px) | Forced aperture sum | Empirical S/N |
|---:|---:|---|---|---:|---:|---:|
| 60841.44885 | 2 | 28.998, 29.002 | 28.890, 28.662 | 0.3570 | not established | not established |
| 60933.69466 | 2 | 28.999, 29.002 | 29.778, 28.867 | 0.7906 | not established | not established |
| 61010.02558 | 2 | 28.999, 29.002 | 28.781, 28.846 | 0.2680 | not established | not established |
| 61084.54264 | 2 | 28.999, 29.002 | 28.989, 29.028 | 0.0278 | not established | not established |
| 61117.91528 | 2 | 29.000, 29.003 | 29.027, 29.081 | 0.0830 | not established | not established |
| 61141.81153 | 2 | 29.000, 29.003 | 28.904, 29.128 | 0.1577 | not established | not established |
| 61212.61827 | 2 | 29.001, 29.003 | 29.083, 29.046 | 0.0924 | not established | not established |
| 61261.49117 | 2 | 29.002, 29.003 | not fitted | not established | not established | not established |
| 61285.89478 | 2 | 29.002, 29.003 | 28.718, 28.898 | 0.3028 | not established | not established |

Not established by this assessment: per band fluxes with validated errors, target saturation checked per input, comparison star calibration floor established, amplitude above 20 percent and comparison floor, independently verified period and phase. These are unmet validation prerequisites, not evidence of physical absence or constancy.

Failed gates: matched wavelength channels, per band fluxes with validated errors, target saturation checked per input, comparison star calibration floor established, amplitude above 20 percent and comparison floor, independently verified period and phase.

## Software and snapshot checks

All render arrays and referenced sidecars are checked byte-for-byte against the fresh backend output. The production browser check requires all five saved presets to render while API requests are denied. Barnard's spectrum and brightness endpoints must also return measurements with the API available. These checks establish reproducibility and wiring, not a science pass for every target.

Browser verification performed: **True**. Browser errors: 0; external requests: 0.

Evidence: [current metrics and hashes](docs/validation/integrated.json), [current React screenshot](docs/validation/react-barnard.png). Historical prototype evidence: [legacy-browser.md](docs/validation/legacy-browser.md).

## Reproduce

```powershell
$env:STORAGE_ACCOUNT_URL=''; $env:APPLICATIONINSIGHTS_CONNECTION_STRING=''
python scripts/validate.py --export-golden
npm.cmd --prefix frontend run build
python scripts/validate.py --chrome '<Chrome executable>' --write-report
python -m pytest -q scripts/tests
```

The default entry runs current integrated validation; `--legacy` explicitly selects the historical prototype runner. Expected science FAIL results are recorded rather than hidden. The normal exit code still requires Barnard PASS and successful software checks. `--write-report` additionally requires the current browser verification before publishing evidence.

## Capture recovery

The original capture log is historical. Each local `frames.csv` and `retry-report.json` records current recovery state: Barnard 121, epsilon Indi B 189, WISE 0855 93, RW Aur 335 and R Dra 337 successful cutouts, totaling **1,075 with zero failures**. All seven failed requests were recovered. Only Barnard's richer B1-B2 capture has been packed and science-validated here; the other displayed packs remain smaller existing demo inputs.

The FITS packer subtracts ZODI once and preserves WCS and named FLAGS. Barnard's demo folder retains 36 longer-wavelength cutouts in addition to the 121 new B1-B2 files. Recovery uses bounded cutout requests, validates FITS shapes, and updates CSV manifests atomically; no full frames are requested. Commands for rebuilding from local raw captures:

```powershell
python scripts/retry_capture.py --capture-root D:/spherex_golden
python scripts/pack_capture.py --capture-root D:/spherex_golden --only barnard
```
