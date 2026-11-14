# Real-data validation

## Barnard's Star in the adopted app

The pack contains 121 new B1-B2 cutouts plus 36 retained longer-wavelength cutouts, totaling 3.37 MB. The adopted FITS packer subtracts ZODI once and retains WCS and named FLAGS. All three tests use **D1 and D2 only** for the displayed stacks, with archive access blocked. Other bands remain available but are not part of this astrometry result.

| Images per detector per season | Loaded cutouts | Measured shift (px) | Gaia shift (px) | Vector error (px) | Astrometry |
|---:|---:|---:|---:|---:|---|
| 3 | 18 | 1.577 | 1.649 | 0.304 | FAIL |
| 10 | 60 | 1.679 | 1.659 | 0.078 | PASS |
| 40 | 121 | 1.646 | 1.656 | 0.108 | PASS |

**Use Demo mode, select only D1 and D2, set Advanced → Images per detector per visit = 10, then reload Barnard.** This tested setting meets the ±0.2 px motion-vector and <0.3 px per-epoch residual criteria. With D1-D2, the normal setting of 3 fails the motion-vector criterion; do not quote it as a science pass. The UI default was not changed in this data-only PR.

The independent reference uses Gaia DR3 J2016.0 astrometry, Astropy space motion and Earth's barycentric position, with no aberration. A 7×7 Gaussian fit measures observed pixels near the prediction. Aperture sums are recorded in the JSON but are not calibrated photometry: Barnard is saturated. Channel matching, field-star alignment scatter, WISE 0855 detection, epsilon Indi B and both variable targets remain unvalidated. A passing Barnard motion test does not establish variability or discovery sensitivity.

## Reproduce

Dependencies: Python 3.11, numpy, astropy, scipy, playwright, pytest and ruff; installed Chrome or Chromium. The packer reuses `tools/fetch_demo.py`. Raw data stays outside Git.

```powershell
python scripts/retry_capture.py --capture-root D:/spherex_golden
python scripts/pack_capture.py --capture-root D:/spherex_golden --only barnard
python scripts/validate.py --chrome '<Chrome executable>' --max-per 3 --out scripts/spike_out/browser-default --report scripts/spike_out/browser-default/report.md
python scripts/validate.py --chrome '<Chrome executable>' --max-per 10 --out scripts/spike_out/browser-10 --report scripts/spike_out/browser-10/report.md
python scripts/validate.py --chrome '<Chrome executable>' --max-per 40 --out scripts/spike_out/browser-40 --report scripts/spike_out/browser-40/report.md
python scripts/validate.py --summarize scripts/spike_out --capture-root D:/spherex_golden --report validation.md
python -m pytest -q scripts/tests/test_capture_validation.py
```

The max-per=3 command intentionally exits 1 for the observed science failure. Detailed measurements and input hashes (recorded at summary generation) are in [docs/validation/barnard.json](docs/validation/barnard.json). Screenshots: [first epoch](docs/validation/barnard-first.png), [first-to-last difference](docs/validation/barnard-difference.png).

## Capture recovery

The original capture log is historical; current state is in each frames.csv and retry-report.json. Recovery validates the recovered image/FLAGS/VARIANCE/ZODI shapes and updates the local CSV manifests atomically; no full frames are requested.

| Target | Successful cutouts | Failed |
|---|---:|---:|
| barnard | 121 | 0 |
| eps_ind_b | 189 | 0 |
| r_dra | 337 | 0 |
| rw_aur | 335 | 0 |
| wise0855 | 93 | 0 |

Most recent recovery receipt: **7** recovered requests. Inventory and receipt are preserved in the JSON evidence.
