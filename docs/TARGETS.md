# Test targets

Single source for target astrometry and pass criteria (moved here from PLAN §6).

- Astrometry is **Gaia DR3 at J2016.0**, queried 2026-11-14 (✓). It is not from SIMBAD: SIMBAD was down, and J2000 or designation coordinates are arcminutes off for the movers.
- **(lit.)** = from literature or memory; confirm before quoting it in the pitch.
- Barnard's captured B1-B2 pack has been tested in the adopted browser app: 10 and 40 images per detector pass the astrometry checks; the default 3 fails. See `validation.md` for measurements, settings and limits. The other targets still await science validation.

Shifts are computed at 6.15″/px.

| Target | Gaia DR3 at J2016.0 | μα*, μδ (mas/yr) | ϖ (mas) | \|μ\| ″/yr, PA | Shift over 6 mo / 1 yr | 2ϖ wobble | β | Preset |
|---|---|---|---|---|---|---|---|---|
| Barnard's Star | 4472832130942575872 · 269.448503, +4.739420 · G 8.19 | −801.6, +10362.4 | 547.0 | 10.39, 356° (N) | 0.85 / **1.69 px** | 0.18 px | +28° | B1-B2 |
| ε Indi B | 6412596012146801152 · 331.076453, −56.793812 · G 18.03 | +3982.0, −2466.8 | 270.7 | 4.68, 122° (ESE) | 0.38 / **0.76 px** | 0.09 px | −42° | B2-B3 |
| WISE 0855−0714 | **not in Gaia** ✓ (no source with \|μ\| > 1″/yr within 3′) | ≈ −8120, +680 (lit.) | ≈ 439 (lit.) | ≈ 8.15, 275° (W) | 0.66 / **1.33 px** | 0.14 px | −24° | B6 |
| RW Aurigae | A 156430822114424576 · 76.956081, +30.401205 · G 12.18; B (1.4″, unresolved) G 13.04 | +2.6, −27.4 | 6.4 | 0.03 (static) | ~0 | — | +7.5° | per band |
| R Draconis | 1648328016354496384 · 248.167378, +66.755007 · G 6.37 | −20.6, +6.1 | 1.25 | 0.02 (static) | ~0 | — | +81° | per band |

**Centring positions for the target picker** (propagated to 2026.0 using proper motion only; recompute per epoch in code):

| Target | Test type | RA | Dec | Status | Note |
|---|---|---|---|---|---|
| Barnard's Star | motion | 269.44627 | +4.76820 | conditional astrometry pass | Captured B1-B2 demo: max-per 10 gives 0.078 px vector error; full capture 0.108 px. Default 3 fails at 0.304 px. Saturated photometry and channel matching remain unvalidated; see `validation.md`. |
| ε Ind B | motion | 331.09665 | −56.80066 | not tested |  |
| WISE 0855 | motion | ≈133.7599 | ≈−7.2422 | not tested | Assumes the designation epoch is ≈2010.5. Replace with SIMBAD's value when it's back, and use FOV ≥ 6′ until then. |
| RW Aur | variability | 76.95608 | +30.40113 | not tested |  |
| R Dra | variability | 248.16723 | +66.75502 | not tested |  |

**What "working" looks like:**
- **Barnard's Star:**
  - Blinking the first and last epochs shows a ~1.7 px hop north.
  - The measured centroid shift is within **±0.2 px** of the Gaia + parallax prediction.
  - The difference image shows a clean N–S dipole.
  - Gaia markers land on the star at every epoch (residual under 0.3 px).
  - Risk: the core is bright (J≈5 (lit.)) and may be OVERFLOW/NONLINEAR, so centroid on the PSF wings with flagged pixels down-weighted.
- **ε Ind B:**
  - The shift is visible at 8× zoom or more, and the dipole appears in the difference image.
  - The centroid is within ±0.2 px of prediction.
  - ε Ind A is very bright and about 6.7′ away (lit.), so keep FOV ≤ 6′ and watch for GHOST/HALO flags.
- **WISE 0855:**
  - A ≥5σ detection in **B6 epoch stacks** in at least 2 epochs, with the shift within ±0.4 px of prediction, plus an **"no Gaia match"** label (PLAN §5.8). That's exactly how it would be discovered.
  - Rough estimate (lit.): about 17.2 AB at 4.5 µm, giving S/N of about 3 per channel and about 10 in a B6 stack.
  - **If it isn't detected, say so in the README.** It's still a valid result.
- **RW Aur:**
  - A classical T Tauri binary with irregular variability; deep optical dimmings happen while the 3–5 µm excess can rise (lit.).
  - Working = per-epoch fluxes per band with error bars, plus a reported change relative to the field-star scatter. **No predicted direction.**
  - It sits near the ecliptic, so expect high zodi and possible asteroid residuals. Use them as the "artefacts that aren't discoveries" teaching moment.
- **R Dra:**
  - A Mira with P ≈ 245.6 d (lit.). Phase advances about 0.74 cycle per 6 months, so the visits sample quite different phases.
  - It's near the pole (β≈+81°), so expect many visits.
  - Working = a light curve whose amplitude is far above the comparison scatter (> 20%), with phases consistent with the period.
  - It's very bright, so check OVERFLOW on the core and prefer the longer-λ channels.

**`scripts/validate.py`:**
- Takes the actual epoch MJDs from each manifest.
- Computes predicted pixel positions.
- Measures centroids (`photutils` centroid_2dg) and aperture fluxes.
- Writes `validation.md`, the table for the README and the pitch.
- **Pitch numbers come only from this file.**
