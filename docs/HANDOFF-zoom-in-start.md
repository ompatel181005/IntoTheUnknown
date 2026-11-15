# Handoff: eddie/zoom-in-start

Branch from `main` (at 6fd93a6, 2026-11-15). Last clean commit: `2cb6c0c`. Pick up from the "In progress" section.

## Done and pushed (2cb6c0c)

- **Zoom-in intro** (`frontend/src/components/Orrery/Orrery.tsx`): on the first home load the camera starts far out (dist 320, pitch 0.7, yaw turned 1.2 rad), then glides to the default view over 3.6 s (ease-out, geometric zoom). Reuses the existing `viewGlide`. Any drag, wheel, reset or flight ends it; skipped for reduced motion, when the page opens on a target, and when returning home. Module-level `intro` state survives StrictMode remounts. Tune with `INTRO_MS` and `introCamera`.
- **Guide dialog** (`components/Guide/*`): fixed header and tabs, one scrolling body, scroll resets on tab change, tabs scroll sideways on phones. Root cause of "scroll does not work": the Orrery's window wheel handler calls `preventDefault()` unless the target is inside `[role="dialog"]`; the native `<dialog>` now has `role="dialog"`.
- **Tour** (`components/Tour/*`, data-tour ids in HomePanel, TopBar, SkyStage, CustomizePanel): 6 steps (search, sort, dome, play, modes, details), each resolving to one visible control on desktop and phone (`fallback` can be a list; phone uses `home-targets-tab`). Focus starts on Next.

## In progress (uncommitted while agents run)

Items come from `docs/UI-FOLLOWUPS.md`. Two agents work in parallel on disjoint files; both edit small parts of `frontend/src/App.tsx` (hotspot: post in team chat).

1. **Layout** (files: SkyStage/*, Orrery/*, AppShell/*, new HomeLegend/, theme.css new tokens, App.tsx inset/legend lines):
   - Source chip, landing hint and RA axis labels overlap under the eyepiece: separate rows.
   - Customize inset: use `PANEL_W + 44 + GUTTER * 2` (App.tsx about line 317).
   - Phone Details: dome about 4 px tall at 390x844; leave about 40 percent of the height.
   - Planet labels (Saturn) clip behind the left HomePanel: treat the panel rect as an edge.
   - Home legend, very subtle: glyph + kind name for kinds present in the catalog, low contrast, hidden during flights and on the target view.
   - Phone grid rebuild: memoize the SkyStage grid so opening Details does not rebuild it (was about 66 ms, 100 to 200 ms frames).
2. **Performance** (files: HomePanel/*, lib/format.ts, App.tsx HomePanel props and search state):
   - HomePanel: `React.memo` plus stable props so a Details click causes zero HomePanel renders (was about 14 ms).
   - List search text state moves inside HomePanel so typing does not re-render App.
   - `lib/format.ts`: cached `Intl.NumberFormat` (identical output).

If these are unfinished when you pick up: run `git diff` to see partial edits, `npx tsc -b && npm run lint && npm run build` in `frontend/`, then finish the items above.

## Queued

3. **Page-wide QA** after 1 and 2 land: in chromium and firefox at 1600x900, 1280x720 and 390x844, click through everything (home intro, drag, zoom buttons, target list search/sort/show/hide, every target, flights there and back, Play, Blink, Difference, Investigate, Customize controls, Details tabs, Guide tabs and scrolling, Tour start to finish, Share, keyboard shortcuts, reduced motion). Report console errors, visual artifacts, overlaps, broken controls; fix clear small bugs.

## Not planned

- Details card briefly over the title (team chose to leave it).
- GPU benchmark (needs an idle machine).
- Blob upload of `frames/catalog/points.json` (command in the #76 PR description).

## How to work on this

- Specs are short and decided: list the files an agent may touch, numbered items, and how to verify. Parallel agents only on disjoint files; shared files get surgical patches.
- Verify with Playwright in chromium and firefox (three sizes), zero console errors, and `npx tsc -b`, `npm run lint`, `npm run build` clean before committing.
- Commits: conventional prefixes (`feat:`, `fix:`, `docs:`), authored by the person committing.
