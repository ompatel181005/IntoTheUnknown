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
# backend: FastAPI on :8000 (Python 3.11+)
cd backend && python -m venv .venv && . .venv/bin/activate && pip install -e ".[dev]"
uvicorn app.main:app --reload --port 8000

# frontend: Vite on :5173, proxies /api and /frames to :8000
cd frontend && npm ci && npm run dev        # open http://localhost:5173
```

One container for production (FastAPI also serves the built React app):

```bash
docker build -t spherex-blink . && docker run -p 8000:8000 spherex-blink   # open http://localhost:8000
```

## Using it

1. **Pick a target.** Click one of the five challenge targets on the sky sphere or in the top bar, or search a name
   or RA, Dec.
2. **Press play.** *Play all* steps through the survey passes; *Blink* flips between two; *Difference* subtracts a
   reference pass, so a moving star becomes a dark/bright pair; *Investigate* opens per-pixel measurements.
3. **Click to measure.** The drawer shows the spectrum and light curve at the clicked pixel.
4. **Customize.** Data source (*Auto*, *Saved* demo pack, *Live* IRSA), field of view (2′–15′), speed and image
   stretch. Everything is kept in the URL, so *Share* gives a link that reopens the same view.

The *Tour* button walks through all of this inside the app.

## The five test targets

| Target | What it is | What to look for |
|---|---|---|
| Barnard's Star | Nearest single red dwarf, fastest-moving star (10.4″/yr) | Slides ~1.7 pixels per year; parallax adds a ±0.55″ wobble |
| ε Indi B | Pair of T-type brown dwarfs orbiting ε Indi A | Moves 4.7″/yr; methane-sculpted spectrum |
| WISE 0855 | Coldest known brown dwarf (~285 K) | Only visible at 4–5 µm (D5–D6); moves 8.1″/yr |
| RW Aurigae | Young T Tauri star with a dusty disc | Irregular dimming, infrared excess |
| R Draconis | Mira variable, 246-day pulsation | Large brightness change between seasons |

## How it works

The browser never talks to IRSA. The React app (`frontend/`) asks the FastAPI backend (`backend/`) for a *view*:

1. **Frames.** The five targets build from the real cutouts in `demo/`, so they work with IRSA down. Any other
   position queries IRSA's SIA service, with TAP as the fallback, and dedupes releases (newest wins).
2. **Cutouts.** Fetched in parallel from IRSA's cutout service, sized from the field of view (never full frames).
3. **Cleaning.** `IMAGE − ZODI`, then masking by the bit names in each file's FLAGS header (`MSKNnnnn` cards).
   SOURCE, OVERFLOW, NONLINEAR, FULLSAMPLE, HALO and BLOOM are kept so bright stars' cores and wings survive;
   TRANSIENT and SUR_ERROR never mask a SOURCE pixel (`docs/DECISIONS.md`).
4. **Grid and stacks.** Each frame is reprojected onto one north-up 6.15″/px grid and stacked per survey pass.
5. **Manifest.** The backend writes `manifest.json` plus one float32 array and mask per pass under `/frames/`. The
   browser does the stretch, blink and difference on a canvas, so the controls are instant.

API contract: `docs/PLAN.md` §4.3, mirrored in `backend/app/models.py` and `frontend/src/types.ts`.

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
cutout keeps every WCS keyword, the FLAGS extension and the WCS-WAVE table, so the backend processes it exactly as it
would a live download. IMAGE is saved with ZODI already subtracted and quantised to 16 bits, with a step of
1/50 of the noise. That changes no measurement, and it keeps the whole pack to a few MB. The builder also saves
Gaia DR3 and AllWISE catalogues of each field for the overlays. `demo/index.json` records when the pack was built
and which releases it holds.

## Tests

```bash
cd backend && ruff check . && ruff format --check . && pytest -q
cd frontend && npm run lint && npm run build
```

CI runs both on every pull request, plus `pytest` in `functions/` and `scripts/`.

## Known limits

- **Gaia overlay.** The manifest has a `gaia` slot, but the backend doesn't fill it yet (`backend/app/processing/gaia.py`
  is in PR #36).
- **AllWISE catalogues** are missing from the demo pack; IRSA TAP returned 502 when it was rebuilt. Rerun
  `python3 tools/fetch_demo.py` when it answers.
- **Saturation.** Barnard's Star and R Dra saturate SPHEREx; the pipeline blanks part of their cores.
- **Blends.** SPHEREx pixels are 6.15″, so neighbours can add light. In 2025 data, WISE 0855 passes ~6″ from a
  background star that is bright at 1–2 µm; only its 4–5 µm points are WISE 0855 itself.

## Files

- `frontend/`: React + Vite + TypeScript app (see `frontend/AGENTS.md`).
- `backend/`: FastAPI service: frame query, cutout fetch, stacking, views API (see `backend/AGENTS.md`).
- `demo/`: real SPHEREx cutouts and catalogues for the five targets; `tools/fetch_demo.py` rebuilds it.
- `functions/`: Azure Functions new-data watcher. `infra/`: Azure scripts.
- `Dockerfile`: one container for API + web app.

Data: NASA/IPAC Infrared Science Archive (SPHEREx), ESA Gaia DR3 (ESA archive and CDS VizieR), AllWISE, CDS
Sesame and Aladin Lite.

## Team workflow
1. start-task: claim an issue, branch from fresh main.
2. build: small commits inside your slice.
3. sync: rebase on origin/main often.
4. ship: checks, secret scan, push, open the PR.
5. merge: once CI is green, squash merge your own PR. No second reviewer is required.
6. handoff: save WIP and leave a note before you stop.

Each step is a playbook in `.claude/skills/`. See [AGENTS.md](AGENTS.md) for the rules, and
[docs/DATA.md](docs/DATA.md) for data acknowledgements. Azure resources: [infra/README.md](infra/README.md).
