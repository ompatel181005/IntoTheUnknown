# SPHEREx Blink

**Every patch of sky, as a little movie.** SPHEREx Blink is our tool for the NASA Space Apps 2026
**Planet X and SPHEREx** challenge. Give it a position on the sky. It finds every image NASA's SPHEREx
telescope has taken of that spot, lines them up and plays them as a short flip-book. Anything that moves or
changes brightness between frames stands out against the fixed background stars.

## What is SPHEREx?

SPHEREx is a NASA telescope that launched on 11 March 2025. It maps the **whole sky every six months** in **102
infrared colours** from 0.75 to 5.0 µm. Its six detector arrays (D1–D6) each sit behind a *linear variable
filter*, so wavelength changes smoothly across each array. As the telescope steps across the sky, a star lands on
a different part of the filter in each exposure. Together those exposures build up its full spectrum.

That makes SPHEREx well suited to "blinking", the method Clyde Tombaugh used to find Pluto. Comparing the same
patch of sky months apart shows nearby stars creeping across the sky, brown dwarfs, pulsating giants and
solar-system bodies.

## Run it

```bash
python3 server.py          # Python 3.8+, standard library only
# open http://localhost:8000
```

`server.py` serves the page and relays requests to IRSA, VizieR and CDS, so the browser doesn't run into
cross-origin (CORS) blocks. It also caches downloaded cutouts in `./cache`. Any static web host works too, such
as GitHub Pages. Without the proxy, *Live IRSA* may be blocked by the browser, but the *Demo pack* and
*Simulated* modes still work.

## Using it

1. **Pick a target.** Click one of the five challenge targets, or type a name or coordinates.
2. **Choose the data.**
   - **Demo pack**: real SPHEREx cutouts bundled in `demo/`. Loads instantly, even offline.
   - **Live IRSA**: the newest data straight from the archive.
   - **Simulated**: a synthetic sky for offline demos and for checking the analysis.
3. **Press play** (space bar). Scroll up or pinch on the dome to zoom, drag to move around, hover a star to identify it, and click to measure it. Step with ← →. The dashed gold line is where the target *should* be, given its
   known motion. The cross-hair marks the current frame's date.
4. **Explore.**
   - *Difference* (key D) subtracts a reference frame. A moving object becomes an orange/blue pair.
   - *3-colour* (key C) shows short, middle and long wavelengths as blue, green and red.
   - Click any star to measure its spectrum. The *Light curve* tab shows its brightness over time.

The **About**, **How to use** and **The science** buttons in the header explain all of this inside the app,
including what to look for in each target.

## The five test targets

| Target | What it is | What to look for |
|---|---|---|
| Barnard's Star | Nearest single red dwarf, fastest-moving star (10.4″/yr) | Slides ~1.7 pixels per year; parallax adds a ±0.55″ wobble |
| ε Indi B | Pair of T-type brown dwarfs orbiting ε Indi A | Moves 4.7″/yr; methane-sculpted spectrum |
| WISE 0855 | Coldest known brown dwarf (~285 K) | Only visible at 4–5 µm (D5–D6); moves 8.1″/yr |
| RW Aurigae | Young T Tauri star with a dusty disc | Irregular dimming, infrared excess |
| R Draconis | Mira variable, 246-day pulsation | Large brightness change between seasons |

## How the challenge requests are covered

| Challenge asks | SPHEREx Blink |
|---|---|
| Play the images like a video | Play, pause, step and speed controls; keyboard shortcuts |
| Test on the five targets | One-click presets with real proper motion and parallax, plus a bundled pack of real data |
| Easy to update with new releases | Live mode queries IRSA's `spherex.plane`/`spherex.artifact` tables, which hold every ingested release, so new weekly data appears automatically and the newest version of each exposure wins (`CONFIG.RELEASE_RANK`). `python3 tools/fetch_demo.py` rebuilds the demo pack. |
| Display the 102 bands creatively; stack each detector | Pick any detectors to stack (median, mean or sum). 3-colour mode maps D1–2, D3–4 and D5–6 to blue, green and red. |
| Spectra on the fly | Aperture photometry in every exposure at each pixel's true wavelength, read from the file's `WCS-WAVE` table. Click anywhere to measure there. |
| Add or subtract images from different times | One frame per season, visit or exposure, or one deep stack (*All*). Difference against a chosen frame, the mean or the previous frame. |
| User-chosen field of view | 2′–30′, with the download size shown before fetching |
| Overlay other telescopes | Gaia DR3 (moved to each frame's date) and AllWISE sources on the movie. The *Sky context* tab opens Aladin Lite on the **real SPHEREx DR1 all-sky map** from IRSA, with a slider across all 102 bands, plus AllWISE, 2MASS, DSS and Pan-STARRS |
| Coordinates in the URL | `?ra=133.79513&dec=-7.24515&pmra=-8123.7&pmdec=673.2&plx=439&epoch=2010.33&fov=4`. Add `&embed=1` for a bare player to put in an iframe. Also `src=demo\|live\|sim`, `frames=epoch\|visit\|each\|all`, `disp=gray\|rgb\|diff`, `det=56`. |
| Metadata and contamination flags | The Exposures tab lists date, detector, wavelength, release, masked fraction and FLAGS status, with file links |
| Use public tools (Astropy, Aladin) | Aladin Lite for sky context. Astropy builds the demo pack and the test archive. |

## How it works

1. **Search.** An ADQL query to IRSA TAP finds every SPHEREx Level-2 spectral image whose footprint contains the
   target. The demo builder falls back to IRSA's SIA service if TAP is down.
2. **Pick.** Exposures are grouped into survey seasons (gaps of more than 45 days). The tool keeps up to N per
   detector per season.
3. **Cutouts.** It requests `<file URL>?center=<ra>,<dec>&size=<deg>` from IRSA's cutout service.
4. **Parse.** A small built-in FITS reader handles IMAGE, ZODI, FLAGS and the WCS-WAVE table. The zodiacal-light
   model is subtracted.
5. **Reproject.** Each cutout is resampled through its own TAN-SIP WCS onto one shared north-up grid at
   6.15″/pixel. SPHEREx rolls between visits, so this step lets frames line up.
6. **Combine, stretch, display.** Frames use an asinh stretch (Lupton et al. 1999) with the sky set near black,
   so the image reads as a dark night sky and both faint and very bright stars show.
7. **Photometry.** A 2.2-pixel aperture with a 4–7-pixel sky annulus, converted from MJy/sr to µJy. An optional
   aperture correction divides by the fraction of a Gaussian PSF that falls on the same pixels. The Gaussian takes
   its width from each file's `PSF_FWHM` header (7.45″ for D1–D3 up to 9.0″ for D6) and is integrated over each
   pixel, because SPHEREx's PSF is undersampled (σ ≈ 0.5–0.6 px).

Everything after the download runs in the browser. There is no build step and no framework.

## The demo pack (`demo/`)

Ingesting everything for a target can take minutes, and the archive isn't always reachable. So the repo ships
real SPHEREx cutouts of the five targets, already downloaded:

```bash
pip install numpy astropy
python3 tools/fetch_demo.py              # all five targets (rebuild when a new release lands)
python3 tools/fetch_demo.py --missing    # only targets that failed last time (archive outages)
python3 tools/fetch_demo.py --only wise0855 --per 4 --fov 8
```

For each target, the builder keeps up to 3 exposures per detector per season (`--per`) as 8′ cutouts. Each
cutout keeps every WCS keyword, the FLAGS extension and the WCS-WAVE table, so the app processes it exactly as it
would a live download. IMAGE is saved with ZODI already subtracted and quantised to 16 bits, with a step of
1/50 of the noise. That changes no measurement, and it keeps the whole pack to a few MB. The builder also saves
Gaia DR3 and AllWISE catalogues of each field for the overlays. `demo/index.json` records when the pack was built
and which releases it holds.

## The simulated sky, and how we checked it

Simulated mode is clearly labelled. It lets the tool work offline and gives a **known answer** to test the
analysis against. It models:

- the target's real proper motion and parallax (the same code that draws the predicted path);
- SPHEREx's **real survey cadence**. The telescope points about 90° from the Sun, so a position is observed when
  the Sun is ~90° from it in ecliptic longitude. That means two short windows a year near the ecliptic, and
  near-continuous coverage near the ecliptic poles (R Dra). Only dates from survey start (2025-05-01) to today
  are used;
- all **six detectors exposed at once**, with wavelengths spread along each linear variable filter;
- physically based spectra (blackbodies plus the main H₂O, CH₄ and CO bands) at roughly each object's real
  brightness, and real variability: Mira pulsation with a 246-day period, and irregular dust dimming for RW Aur
  that is stronger at short wavelengths;
- field stars whose density follows Galactic latitude, matching Gaia/AllWISE overlay entries, and one slow
  distant solar-system body (~3″/hour), the kind of mover a "Planet X" search looks for.

In simulated mode the Spectrum tab draws the input model as a dashed line, so you can see that the measurement
matches. `tests/test_sim.py` checks this automatically for all five targets:

```
Barnard's Star  centroid max=0.002px  flux ratio median=1.000  6-det simultaneous=True
ε Indi B        centroid max=0.083px  flux ratio median=1.000  6-det simultaneous=True
WISE 0855       centroid max=0.740px  flux ratio median=0.977  6-det simultaneous=True   (faint: low S/N)
RW Aurigae      centroid max=0.001px  flux ratio median=1.000  6-det simultaneous=True
R Draconis      centroid max=0.007px  flux ratio median=1.000  6-det simultaneous=True
PASS
```

PSF width and single-exposure depths in the simulation are approximations, not calibrated values.

## Tests

```bash
pip install playwright numpy astropy
python3 server.py --port 8811 &
python3 tests/test_sim.py /tmp/shots --base http://127.0.0.1:8811       # simulated known-answer test
python3 tests/test_demo.py /tmp/shots --base http://127.0.0.1:8811      # real demo pack: wavelengths, unbiased photometry
python3 tests/test_ui.py /tmp/shots --base http://127.0.0.1:8811 --live # every button, view, tab and interaction (46 checks)
python3 tests/mock_server.py . 8765 &                                    # mock IRSA with real-format FITS
python3 tests/run_test.py /tmp/shots                                     # live path against the mock archive
```

## Known limits

- **FLAGS.** Bit meanings are read *by name* from each file's own FLAGS header (cards such as `MSKN0010 = 'HOT'`), not
  from a hard-coded layout. Pixels whose bits are named in `FLAG_MASK_NAMES` (non-functional, missing, hot, cold)
  are blanked; SUR_ERROR and TRANSIENT are blanked only off SOURCE pixels, and OVERFLOW is kept so bright cores survive. Every bit is counted, and hovering the *flags* cell in the Exposures tab shows the
  breakdown. `SOURCE` pixels (on a detected star) are not counted as bad. If a file carries no bit definitions,
  flags are reported but nothing is blanked.
- **Per-pixel wavelength.** It comes from the file's `WCS-WAVE` table: a 9×9 grid of [wavelength, bandwidth]
  pairs, read according to its `TDIM` (real files interleave the pair: `(2,9,9)`). The cutout's offset on the
  detector comes from the alternate WCS `A` keywords. If those are missing, the tool uses the detector's band centre
  and says so in the Exposures tab.
- **Blends.** The photometry aperture has a 13.5″ radius (SPHEREx pixels are 6.15″), so a neighbouring star can
  add light. Example: in the 2025 data, WISE 0855 passes ~6″ from a background star that is bright at 1–2 µm, so
  its short-wavelength points are that star while its 4–5 µm points are WISE 0855 itself. Blank-sky apertures in
  the same cutouts measure 0 ± noise, so this is real light, not a bias.
- **Saturation** of very bright stars (Barnard's Star, R Dra) is not modelled in the simulation. In real data,
  saturated cores are flagged.

## Files

- `index.html`: the whole app (HTML, CSS and JavaScript). The `CONFIG` block at the top of the script holds
  endpoints and tunables.
- `server.py`: static server, archive proxy and cutout cache.
- `tools/fetch_demo.py`: builds or refreshes the bundled demo pack.
- `demo/`: real SPHEREx cutouts and catalogues for the five targets.
- `tests/`: simulated known-answer test, mock IRSA server and live-path test.

Aladin Lite is loaded from jsDelivr (`aladin-lite@3.8.2`), because CDS's old `.../v3/latest/aladin.js` URL now returns 404.
AllWISE and 2MASS sky tiles come from IRSA's mirrors, which stay up when CDS's tile server doesn't.

Data: NASA/IPAC Infrared Science Archive (SPHEREx), ESA Gaia DR3 and AllWISE via CDS VizieR, and CDS Sesame and
Aladin Lite.

## Team workflow
1. start-task: claim an issue, branch from fresh main.
2. build: small commits inside your slice.
3. sync: rebase on origin/main often.
4. ship: checks, secret scan, push, open the PR.
5. merge: once CI is green, squash merge your own PR. No second reviewer is required.
6. handoff: save WIP and leave a note before you stop.

Each step is a playbook in `.claude/skills/`. See [AGENTS.md](AGENTS.md) for the rules, and
[docs/DATA.md](docs/DATA.md) for data acknowledgements. Azure resources: [infra/README.md](infra/README.md).
