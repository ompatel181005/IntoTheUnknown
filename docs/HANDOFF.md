# Handoff: eddie/space-direction (frontend UI)

Last updated 2026-11-14. Branch `eddie/space-direction`, head is the commit that added this file. Nothing is merged to `main` yet; open a PR when the outstanding items below are done.

## What this branch is

The public SPHEREx sky flipbook for the Planet X and SPHEREx challenge: pick a target (or type RA, Dec), watch the SPHEREx passes play like a little video, spot what moves or changes brightness. The UI aims to feel like NASA Eyes on the Solar System and Stellarium: a live 3D sky on the home screen, a short cinematic flight into the target, then a planetarium dome view of the real data.

## Current state, what works

Run it: backend `cd backend && .venv/bin/uvicorn app.main:app --reload --port 8000`, frontend `cd frontend && npm run dev` (http://localhost:5173). `npx tsc -b`, `npm run lint`, `npm run build` and backend `pytest` (9 tests) all pass at this commit.

- **Home**: full-screen 3D sky (4,000 stars and the Milky Way at infinity, all of it turns when you drag), the solar system with planets at their real positions for today (JPL approximate elements, verified exact), and the five targets as clickable markers. Heading is just "Pick a target".
- **Nav bar**: brand and breadcrumb, one centred type-ahead search (ARIA combobox: full target names, one-line descriptions, aliases like "eps" or "mira", "Go to RA, Dec" for coordinates), Guide and Share. No acronym chips.
- **Flight to a target**: about 700 ms turn and dolly, commit at about 550 ms, 750 ms dome zoom from the clicked marker; starfield warp radiates from the target. Side panels hide during the flight and fade back after.
- **Flight home**: the app remembers the home camera; going home starts facing the target you left and flies back out to where you were, warp radiating from that target.
- **Target view**: north-up dome with PA ring, grid, playback arc (Play all, Blink, Difference, Investigate), Customize panel docked left (data source Auto/Saved/Live, FOV, speed, infrared band, brightness, smoothing, invert), tool rail right, details drawer (pass, spectrum, brightness, files, sky).
- **Tour** (5 steps, opens from the Guide button) and **Guide** dialog. Keyboard shortcuts: Space, arrows, B, D, C, I, ?, Esc.
- **Font**: Manrope Variable for UI, JetBrains Mono for numbers.
- **Sky catalog** (backend): `GET /api/catalog?set=targets` serves positions, parallaxes, proper motions and provenance. Local JSON now (`backend/data/catalog/targets.json`), Azure Blob later by setting `CATALOG_STORE=azure_blob` and `CATALOG_BLOB_URL`. See `docs/CATALOG.md`. Frontend has `getCatalog`, `useCatalog`, `lib/catalog.ts` helpers ready.

## Outstanding (in priority order)

1. **Finish the orrery zoom work (commit `ecc9206` is WIP).** Spec: `docs/handoff/spec-f.md`. Done so far: wheel, pinch and keyboard zoom, labels scale with zoom, label collision fading, obliquity fix. Still to do:
   - **Remove panning.** Decision after the spec was written: the view stays centred on the Sun the whole time; zoom in and out only (wheel, pinch, + and - keys, small + and - buttons, 0 to reset), zooming toward the centre, not the cursor. Left-drag rotate stays. Delete right/shift/middle-drag pan, two-finger pan, double-click focus (`panBy`, `planetDoubleClick`, `focusTarget` in `Orrery.tsx`). This overrides spec items 3 (zoom toward cursor) and 4 (pan).
   - **Read star and target positions from `useCatalog()`**, not hardcoded values; render any number of catalog objects, clickable only when `preset_id` is set.
   - Apply the radial scale and default zoom from `docs/handoff/research-positions-and-scale.md` section 4 and 5 so the inner planets are clearly separated by default.
   - Verify: screenshots in chromium and firefox, no overlapping labels, angle-error table, frame times.
2. **Finish the flight performance pass (partially in `ecc9206`).** Spec: `docs/handoff/spec-g.md`. Goal: every frame on time at 60 Hz (p95 <= 17 ms, max <= 25 ms) in chromium and firefox for marker click, search pick and going home, without cutting stars, effects or timing. Done so far: the flying backdrop-filter rule is scoped to the app shell, some SkyBackdrop and Eyepiece timing changes. Not measured yet, so confirm nothing regressed first. Last known numbers: chromium flight p95 16.7 ms; firefox flight p95 about 50 ms, max about 83 ms (firefox is the remaining problem).
3. **Update the old target values outside the 3D view.** The catalog has the corrected numbers, but `frontend/src/lib/targets.ts` (info panel facts, view queries) still has: Eps Indi B parallax 270.7 (should be 274.99 mas), RW Aur parallax 6.4 (should be 5.4541 mas), WISE 0855 position from about 2013 (2026 is about 133.7359, -7.2403). Ideally make these read from the catalog too.
4. **Azure Blob**: `AzureBlobCatalogStore` is untested against a real blob. Whoever owns issue #12 should confirm the layout `<container>/catalog/<set>.json`.
5. **Gaia overlay** is still "coming soon" in the rail and drawer.
6. **Team chat**: announce hotspot changes from this branch (AGENTS.md): `frontend/src/App.tsx`, `frontend/package.json` (Manrope added, Inter removed), `backend/app/main.py` (new `/api/catalog` route).
7. Delete `docs/handoff/` and this file before merging, or keep them if the team wants the record.

## Known issues

- Home labels in the middle of the solar system still crowd at the default zoom until item 1 lands.
- Firefox drops frames during flights (see item 2).
- One QA run saw a single `net::ERR_CONNECTION_REFUSED` in chromium on the Barnard Brightness tab (backend restart during the run); not reproduced since.
- If animations look missing on Windows, check Settings > Accessibility > Visual effects > Animation effects: the app honours `prefers-reduced-motion` with short fades instead of flights. After pulling, hard refresh (Ctrl+Shift+R) or restart Vite with `--force`; stale tabs showed old behaviour before.

## How we have been working

- **Orchestrator plus implementation agents.** One coordinating session writes a short, decided spec per task (files the agent may touch, numbered requirements, acceptance checks), launches implementation agents (Codex CLI, `codex exec -s workspace-write`, high reasoning effort for quality work, low effort for research or routine QA), then reviews each result before committing. Shared rules every agent gets are in `docs/handoff/spec-common.md`: edit only listed files, no git commands, no new dependencies, no em dashes, tsc/lint/build clean, verify in chromium and firefox at 1600x900 and 390x844 with zero console errors.
- **Parallel only on disjoint files.** Tasks that touch the same file (Orrery, App.tsx) run one after another; parallel agents get an explicit "do not touch" list and are told to make small patches, re-reading the file before each one.
- **Research before building when facts matter.** A read-only research agent verified the planet elements, target astrometry and a scale recommendation (`docs/handoff/research-positions-and-scale.md`) before the implementation spec used them.
- **Measure, then fix.** Animation work is judged by Playwright rAF frame-time stats (frames, p50, p95, max) in both browsers before and after, plus long-animation-frame attribution in chromium, and by short recorded videos, not by eye alone.
- **Review every result.** Read the agent's report, check the diff stays inside its file list, look at its screenshots, rerun tsc/lint/build (and pytest for backend), fix small issues directly (for example the see-through search dropdown), then commit.
- **Commits**: authored as Eduardo Galvan with plain descriptive messages, pushed to this branch; no direct commits to `main`.

## Decisions to keep

- Real space look, not sci-fi hologram: neutral stars, soft Milky Way, plain white target rings, Eyes planet palette.
- Flights stay short (about 0.7 s plus 0.75 s dome zoom). Reduced motion gets 150 ms fades.
- Copy: only what is needed, plain words, sentence case, no disclaimers, no em dashes. Keep data release, date, pixel scale and orientation, said once.
- Home view: zoom only, centred on the Sun, no pan (for now).
- No positions or distances hardcoded in the 3D view; everything comes from the swappable catalog.
- Canvas 2D, no WebGL or animation libraries before submission.
