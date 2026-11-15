# Into The Unknown

**Every patch of sky, as a little movie.** Into The Unknown is our entry for the NASA Space Apps 2026
**Planet X and SPHEREx** challenge, by team **LOGICA**. Give it a position on the sky. It aligns selected
SPHEREx observations and plays them as a short flipbook, helping people inspect possible motion and
brightness changes. Interpretation still depends on coverage, wavelength, noise and the science gates below.

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

1. **Pick a target.** The home list contains 47 prepared fields, including the five challenge presets. Use
   the list or search for a name or RA, Dec. The five default presets prefer bundled saved snapshots;
   other prepared fields can load immutable cached images from public Blob.
2. **Press play.** *Play all* steps through the survey passes; *Blink* flips between two; *Difference* subtracts a
   reference pass, so a moving star becomes a dark/bright pair; *Investigate* opens per-pixel measurements.
3. **Click to measure.** The drawer shows the spectrum and light curve at the clicked pixel.
4. **Customize.** Data source, field of view, speed and image stretch.

The *Tour* button walks through the viewer. **[Learn & explore](https://ca-planetx-api.politesand-6f83d8b5.westus.azurecontainerapps.io/learn.html)**
offers three saved-data activities in English, Spanish and Hindi: Barnard motion, RW Aur wavelength
comparability, and WISE uncertainty. Learners observe, check curated explanations and share a URL or an
image-based PNG postcard. These are guided observations, not scored detections or calibrated pixel measurements.
Spanish and Hindi translations are initial drafts.

**The URL is the state.** *Share* copies a link that reopens the same view, and the link can be written by hand:

| Parameter | Values | Meaning |
|---|---|---|
| `ra`, `dec` | degrees | Centre of the view |
| `point` | catalog object ID | Prepared field selected from the home catalog |
| `target` | `barnard`, `eps-ind-b`, `wise-0855`, `rw-aur`, `r-dra` | Preset the view came from |
| `fov` | `2`, `4`, `6`, `10`, `15` | Field of view in arcminutes |
| `band` | `auto`, `B1`…`B6`, `B1-B2`, `B1-B3`, `all` | Which detectors are stacked |
| `src` | `auto`, `saved`, `live` | Auto uses saved/cache where applicable; Saved requires saved data; Live requests archive observations |
| `mode` | `all`, `blink`, `diff`, `inspect` | Play all, Blink, Difference, Investigate |
| `epoch`, `ref` | 1-based pass number | Pass shown, and the reference pass for Blink and Difference |
| `sel` | `x,y` | Pixel selected for measurements |
| `panel` | `pass`, `colours`, `brightness`, `files`, `sky` | Open drawer tab |
| `speed`, `gain`, `stretch`, `invert`, `raw`, `ov` | — | Playback speed, brightness, `linear` stretch, inverted, unsmoothed pixels, overlays |

Example: `/?ra=269.44627&dec=4.76820&fov=6&target=barnard&band=B1-B2&mode=blink`

## 3. The five validation targets

Measured results come from [`validation.md`](validation.md). Barnard's Star and epsilon Indi B pass the stated
astrometry checks against independent predictions. All five saved products are assessed; WISE 0855, RW Aur and
R Dra have unmet science prerequisites, recorded explicitly in the report.

| Target | What it is | Loads with the API down | Science |
|---|---|---|---|
| Barnard's Star | Nearby red dwarf with the largest known proper motion | Pass | **Astrometry pass** |
| ε Indi B | Pair of T-type brown dwarfs orbiting ε Indi A | Pass | **Astrometry pass** |
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

**Epsilon Indi B, default preset (4 passes from 148 cutouts):** measured shift 1.0587 px, predicted shift
1.0552 px, motion-vector error **0.0308 px**, and largest positional residual **0.1606 px**. Both errors are
within the stated 0.2 px gates. This assesses the unresolved pair's astrometry; it does not validate its photometry.

The prediction uses Gaia DR3 J2016.0 astrometry, Astropy space motion and Earth's barycentric position, with no
aberration. Catalogue values and pass criteria for all five targets are in [`docs/TARGETS.md`](docs/TARGETS.md).
`validation.md` also explains how to reproduce the run.

## 4. Method

The browser never talks to IRSA. Bundled/prepared views load saved assets directly. For an uncached request,
the React app (`frontend/`) asks the FastAPI backend (`backend/`) for a *view*:

1. **Frames.** The five targets build from the real cutouts in `demo/`, so they work with IRSA down. Any other
   position queries IRSA's SIA service, with TAP as the fallback, and dedupes releases (newest wins).
2. **Cutouts.** Fetched in parallel as range reads of the pixel window from IRSA's public AWS mirror, with
   IRSA's cutout service as the fallback. Sized from the field of view (never full frames).
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
   (`backend/app/processing/gaia.py`), using ESA TAP with ARI Heidelberg fallback. Visible Gaia markers and
   motion arrows provide context; the selected-source match label is a cross-match, not proof of discovery.
   The API serves predictions at `/api/views/{id}/gaia`. Bundled field catalogues came through CDS VizieR.

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
| Blob Storage | Render cache: finished views survive deploys, and the browser loads images straight from Blob | Live |
| Functions | Daily metadata check and five pinned Live refresh requests | Deployed/indexed; authentication and OIDC deployment verified; successful metadata refresh pending IRSA recovery |
| Log Analytics + Application Insights | Platform logs; API latency, cache hits and archive failures | Configured; SDK/KQL verification details in infra docs |

Details, scripts and costs: [`infra/README.md`](infra/README.md). The watcher has 2048 MB, a maximum of two
instances and zero always-ready instances. [Live host/authentication receipt](infra/watcher-live-checks.json)
and [main-only OIDC deployment run](https://github.com/ompatel181005/IntoTheUnknown/actions/runs/43708187059)
record deployment, not a successful upstream metadata refresh. A refresh 202 means accepted work, not
completed frames; the watcher does not rebuild all 47 prepared fields or change bundled snapshots.

[Catalog receipt](infra/catalog-live-checks.json): all 47 fields / 152 passes were checked for public asset
availability and rendered in Chrome without API builds. [Preset/Learn receipt](infra/preset-live-checks.json):
all five defaults painted with API requests denied, and nine language/activity combinations passed at a
320-pixel emulated viewport, with share round-trip and English/Hindi PNG downloads. These dated receipts
identify the tested source commit; they are delivery checks, not scientific validation or physical-phone tests.

## 6. Limitations

- **Pixels and baseline.** SPHEREx pixels are 6.15″ and the baseline is about one year, so only fast movers
  shift by a pixel or more.
- **Science gates have a limited scope.** The two astrometry passes are described in section 3. WISE 0855's
  detection and RW Aur/R Dra variability are not established by this assessment. No discovery is claimed.
- **Gaia context.** The overlay is active where Gaia data is available. Missing catalog matches alone do not establish an astrophysical detection or a new object.
- **Saturation.** Barnard's Star and R Dra saturate SPHEREx; the pipeline blanks part of their cores, and
  their aperture sums are not calibrated photometry.
- **Blends and faint sources.** Neighbours can add light inside a 6.15-arcsecond pixel. WISE 0855 has no
  validated detection in the bundled assessment; a forced-aperture signal or a visible patch is insufficient.
- **RW Aurigae.** One pass has a field-star scale of about 0.925. That is a calibration concern, not a
  variability detection.
- **Uncached positions depend on IRSA.** Prepared catalog fields can use cached images. A new field still
  needs IRSA exposure metadata, even when S3 supplies its pixels. IRSA TAP returned HTTP 502 during the latest
  watcher verification; the saved/prepared images remain separate from that unsuccessful refresh.

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
cd frontend && npm run lint && npm run build && node --experimental-vm-modules --test tests/*.test.mjs
```

CI runs both on every pull request, plus `pytest` in `functions/` and `scripts/`. Merges to `main` deploy to
Azure automatically (`infra/README.md`).

## 8. Data citations and acknowledgements

Full credits and the verbatim supplied mission/database statements are in **[docs/DATA.md](docs/DATA.md)**.
Use that file when preparing the final submission; it links the complete official IRSA archive statement.

- **NASA SPHEREx:** DR1 and QR3 Level 2 spectral-image cutouts via NASA/IPAC IRSA metadata and its public S3
  mirror, with IRSA cutout fallback. DR1 images DOI [10.26131/IRSA678](https://doi.org/10.26131/IRSA678);
  QR3 DOI [10.26131/IRSA662](https://doi.org/10.26131/IRSA662). No All-Sky Cube is used.
- **ESA Gaia DR3 / DPAC:** validation references, propagated overlay and field-star alignment. Runtime
  access is ESA TAP, then ARI Heidelberg; bundled field catalogues used CDS VizieR.
- **SIMBAD / CDS and per-object literature:** supplied home-catalog metadata, with each original reference
  preserved. Cite Wenger et al. (2000), DOI [10.1051/aas:2000332](https://doi.org/10.1051/aas:2000332).
- **CatWISE2020 via IRSA:** the pinned WISE 0855 reference position. Its motion/parallax and this dataset's
  detection significance remain unvalidated in the current assessment.
- **Software:** Astropy, astroquery, reproject, NumPy, SciPy, s3fs, FastAPI, React and Vite.

## 9. AI-tools disclosure

AI coding assistants (Claude Code, Cursor and OpenAI Codex) wrote and reviewed much of the code, tests,
infrastructure scripts and documentation in this repository, directed and checked by the team. The project idea
is the team's own. Pixel measurements and validation results are computed from real observations. Supplied catalog metadata
retains its source attribution and is distinct from validated science. The app does not use AI to infer
astronomical detections. The app contains no AI-generated images, video or data.

## 10. Team

Team LOGICA: Diego, Eddie, Himanshu, Om, Ammar and Angelo.

How we work: one owner per GitHub issue, short-lived branches, squash merges once CI is green. The rules are in
[AGENTS.md](AGENTS.md) and the playbooks in `.claude/skills/`.

## 11. License

[MIT](LICENSE). SPHEREx and Gaia data keep their own terms; see section 8.
