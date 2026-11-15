# Into The Unknown

**Every patch of sky, as a little movie.** Into The Unknown is our entry for the NASA Space Apps 2026
**Planet X and SPHEREx** challenge. Give it a position on the sky. It finds every image NASA's SPHEREx
telescope has taken of that spot, lines them up and plays them as a short flip-book. Anything that moves or
changes brightness between frames stands out against the fixed background stars.

**Live app (no login):** https://ca-planetx-api.politesand-6f83d8b5.westus.azurecontainerapps.io

## 1. What and why

SPHEREx is a NASA telescope that launched on 11 March 2025. It maps the **whole sky every six months** in **102
infrared colours** from 0.75 to 5.0 µm. Its six detector arrays (D1–D6) each sit behind a *linear variable
filter*, so wavelength changes smoothly across each array. As the telescope steps across the sky, a star lands on
a different part of the filter in each exposure. Together those exposures build up its full spectrum.

That makes SPHEREx well suited to "blinking", the method Clyde Tombaugh used to find Pluto. Comparing the same
patch of sky months apart shows nearby stars creeping across the sky, brown dwarfs, pulsating giants and
solar-system bodies.

The data is public, but it arrives as multi-extension FITS files queried through Python. Into The Unknown lets
anyone answer "did anything move or change here?" from a web page: citizen scientists, teachers and students,
and astronomers who want a quick look before downloading anything.

## 2. How to use

1. **Pick a target.** Click one of the five challenge targets in the home sky, or use the search box for a
   name or an RA, Dec.
2. **Press play.** *Play all* steps through the survey passes; *Blink* flips between two; *Difference* subtracts a
   reference pass, so a moving star becomes a dark/bright pair; *Investigate* opens per-pixel measurements.
3. **Click to measure.** The drawer shows the spectrum and light curve at the clicked pixel.
4. **Customize.** Data source, field of view, speed and image stretch.

The *Tour* button walks through all of this inside the app.

**The URL is the state.** *Share* copies a link that reopens the same view, and the link can be written by hand:

| Parameter | Values | Meaning |
|---|---|---|
| `ra`, `dec` | degrees | Centre of the view |
| `target` | `barnard`, `eps-ind-b`, `wise-0855`, `rw-aur`, `r-dra` | Preset the view came from |
| `fov` | `2`, `4`, `6`, `10`, `15` | Field of view in arcminutes |
| `band` | `auto`, `B1`…`B6`, `B1-B2`, `B1-B3`, `all` | Which detectors are stacked |
| `src` | `auto`, `saved`, `live` | Saved demo pack, live IRSA, or whichever is available |
| `mode` | `all`, `blink`, `diff`, `inspect` | Play all, Blink, Difference, Investigate |
| `epoch`, `ref` | 1-based pass number | Pass shown, and the reference pass for Blink and Difference |
| `sel` | `x,y` | Pixel selected for measurements |
| `panel` | `pass`, `colours`, `brightness`, `files`, `sky` | Open drawer tab |
| `speed`, `gain`, `stretch`, `invert`, `raw`, `ov` | — | Playback speed, brightness, `linear` stretch, inverted, unsmoothed pixels, overlays |

Example: `/?ra=269.44627&dec=4.76820&fov=6&target=barnard&band=B1-B2&mode=blink`

## 3. The five validation targets

Measured results come from [`validation.md`](validation.md) and nothing else. Only Barnard's Star has validated
science so far. The other four load and play, but their motion or variability has not been measured against a
reference, so we make no claim for them.

| Target | What it is | Loads with the API down | Science |
|---|---|---|---|
| Barnard's Star | Nearby red dwarf with the largest known proper motion | Pass | **Astrometry pass** |
| ε Indi B | Pair of T-type brown dwarfs orbiting ε Indi A | Pass | Not validated |
| WISE 0855 | Coldest known brown dwarf; not in Gaia | Pass | Not validated |
| RW Aurigae | Young T Tauri star with a dusty disc | Pass | Not validated |
| R Draconis | Mira variable | Pass | Not validated |

**Barnard's Star, default preset (B1-B2, 6′ field, 3 passes from 115 cutouts):**

| Measurement | Result | Criterion |
|---|---:|---:|
| First-to-last centroid shift | 1.6425 px | Compare with the Gaia prediction |
| Gaia proper motion + parallax prediction | 1.6687 px | Independent Astropy calculation |
| Motion-vector error | **0.0410 px, pass** | At most 0.2 px |
| Largest per-pass positional residual | **0.1704 px, pass** | Less than 0.3 px |

The prediction uses Gaia DR3 J2016.0 astrometry, Astropy space motion and Earth's barycentric position, with no
aberration. Catalogue values and pass criteria for all five targets are in [`docs/TARGETS.md`](docs/TARGETS.md).
`validation.md` also explains how to reproduce the run.

## 4. Method

The browser never talks to IRSA. The React app (`frontend/`) asks the FastAPI backend (`backend/`) for a *view*:

1. **Frames.** The five targets build from the real cutouts in `demo/`, so they work with IRSA down. Any other
   position queries IRSA's SIA service, with TAP as the fallback, and dedupes releases (newest wins).
2. **Cutouts.** Fetched in parallel from IRSA's cutout service, sized from the field of view (never full frames).
3. **Cleaning.** `IMAGE − ZODI`, then masking by the bit names in each file's FLAGS header (`MSKNnnnn` cards).
   SOURCE, OVERFLOW, NONLINEAR, FULLSAMPLE, HALO and BLOOM are kept so bright stars' cores and wings survive;
   TRANSIENT and SUR_ERROR never mask a SOURCE pixel (`docs/DECISIONS.md`).
4. **Grid and stacks.** Each frame is reprojected onto one north-up 6.15″/px grid. Frames are grouped into
   survey passes and stacked per pass over the wavelength channels common to every pass, so a blink compares
   like with like.
5. **Alignment check.** Centroids of Gaia field stars in each stack are compared with their predicted positions.
   A mean offset over 0.15 px is corrected, and the residual is written to the manifest as `astrom_resid_px`.
6. **Stretch, blink and difference.** One asinh stretch is shared by every pass. The backend writes
   `manifest.json` plus one float32 array and mask per pass under `/frames/`; the browser does the stretch,
   blink and difference on a canvas, so the controls are instant.
7. **Gaia + parallax.** Gaia DR3 positions are propagated to each pass with proper motion and parallax
   (`backend/app/processing/gaia.py`). The API serves the predictions at `/api/views/{id}/gaia`.

API contract: `docs/PLAN.md` §4.3, mirrored in `backend/app/models.py` and `frontend/src/types.ts`.

### The demo pack (`demo/`)

Ingesting everything for a target can take minutes, and the archive isn't always reachable. So the repo ships
real SPHEREx cutouts of the five targets, already downloaded:

```bash
pip install numpy astropy
python3 tools/fetch_demo.py              # all five targets (rebuild when a new release lands)
python3 tools/fetch_demo.py --missing    # only targets that failed last time (archive outages)
python3 tools/fetch_demo.py --only wise0855 --per 4 --fov 8
```

Each cutout keeps every WCS keyword, the FLAGS extension and the WCS-WAVE table, so the backend processes it
exactly as it would a live download. IMAGE is saved with ZODI already subtracted and quantised to 16 bits, with
a step of 1/50 of the noise. The builder also saves a Gaia DR3 catalogue of each field. `demo/index.json`
records when the pack was built and which releases it holds.

## 5. Architecture and Azure services

One container runs FastAPI, which serves both the API and the built React app. Pre-computed snapshots of the
five targets ship inside the frontend, so the presets render even when the API is failing.

| Azure service | What it does for us | State |
|---|---|---|
| Container Apps + Container Registry | Hosts the public app; GitHub Actions builds and deploys `main` | Live |
| User-assigned managed identity | Registry pulls and Blob access with no stored secrets | Live |
| Blob Storage | Render cache and watcher state | Account live; backend cache integration in progress |
| Functions | Daily watcher that detects new SPHEREx data | Code in `functions/`; deployment pending |
| Log Analytics + Application Insights | Platform logs; API latency, cache hits and archive failures | Logs live; app telemetry merged, not yet verified live |

Details, scripts and costs: [`infra/README.md`](infra/README.md).

## 6. Limitations

- **Pixels and baseline.** SPHEREx pixels are 6.15″ and the baseline is about one year, so only fast movers
  shift by a pixel or more.
- **Only one target is validated.** See section 3. The tool shows candidates to look at; it never claims a
  discovery.
- **Gaia overlay.** The backend serves Gaia predictions, but the overlay toggle in the app is not switched on
  yet.
- **Saturation.** Barnard's Star and R Dra saturate SPHEREx; the pipeline blanks part of their cores, and
  their aperture sums are not calibrated photometry.
- **Blends.** Neighbours can add light inside a 6.15″ pixel. In 2025 data, WISE 0855 passes ~6″ from a
  background star that is bright at 1–2 µm; only its 4–5 µm points are WISE 0855 itself.
- **RW Aurigae.** One pass has a field-star scale of about 0.925. That is a calibration concern, not a
  variability detection.
- **Live positions depend on IRSA.** Positions outside the five saved fields need the archive to answer.

## 7. Run locally and deploy

```bash
# backend: FastAPI on :8000 (Python 3.11+)
cd backend && python -m venv .venv && . .venv/bin/activate && pip install -e ".[dev]"
uvicorn app.main:app --reload --port 8000

# frontend: Vite on :5173, proxies /api and /frames to :8000
cd frontend && npm ci && npm run dev        # open http://localhost:5173
```

One container for production:

```bash
docker build -t spherex-blink . && docker run -p 8000:8000 spherex-blink   # open http://localhost:8000
```

Tests:

```bash
cd backend && ruff check . && ruff format --check . && pytest -q
cd frontend && npm run lint && npm run build
```

CI runs both on every pull request, plus `pytest` in `functions/` and `scripts/`. Merges to `main` deploy to
Azure automatically (`infra/README.md`).

## 8. Data citations and acknowledgements

Full details: [`docs/DATA.md`](docs/DATA.md).

**SPHEREx (NASA, via the NASA/IPAC Infrared Science Archive).** Level 2 spectral-image cutouts from DR1 and QR3.
DOIs: DR1 Spectral Images [10.26131/IRSA678](https://doi.org/10.26131/IRSA678), QR3
[10.26131/IRSA662](https://doi.org/10.26131/IRSA662).

> This publication makes use of data products from the Spectro-Photometer for the History of the Universe, Epoch of Reionization and Ices Explorer (SPHEREx), which is a joint project of the Jet Propulsion Laboratory and the California Institute of Technology, and is funded by the National Aeronautics and Space Administration.

**Gaia DR3 (ESA).** Positions, proper motions and parallaxes for the target presets, the predictions and the
alignment check. Credit: ESA/Gaia/DPAC. Cite Gaia Collaboration et al. (2016b) and Gaia Collaboration et al.
(2023j).

> This work has made use of data from the European Space Agency (ESA) mission Gaia (https://www.cosmos.esa.int/gaia), processed by the Gaia Data Processing and Analysis Consortium (DPAC, https://www.cosmos.esa.int/web/gaia/dpac/consortium). Funding for the DPAC has been provided by national institutions, in particular the institutions participating in the Gaia Multilateral Agreement.

**Other.** The WISE 0855 position comes from CatWISE2020 (via IRSA). The demo pack's Gaia field catalogues were
downloaded through CDS VizieR.

**Software.** Astropy, astroquery, reproject, NumPy, SciPy, FastAPI, React and Vite.

## 9. AI-tools disclosure

AI coding assistants (Claude Code, Cursor and OpenAI Codex) wrote and reviewed much of the code, tests,
infrastructure scripts and documentation in this repository, directed and checked by the team. The project idea
is the team's own. Every number the app shows is computed by our code from SPHEREx and Gaia data, never
generated by a language model. The app contains no AI-generated images, video or data.

## 10. Team

Diego, Eddie, Himanshu, Om, Ammar and Angelo.

How we work: one owner per GitHub issue, short-lived branches, squash merges once CI is green. The rules are in
[AGENTS.md](AGENTS.md) and the playbooks in `.claude/skills/`.

## 11. License

[MIT](LICENSE). SPHEREx and Gaia data keep their own terms; see section 8.
