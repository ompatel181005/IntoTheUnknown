# Routing and task tracking (eddie/space-direction)

Orchestrator: the main Claude session (orchestrates only; it never writes feature code). Implementation agents are Codex CLI and agy (Gemini) only, no Claude agents. It scores each task, writes the tier into the handoff, decides escalations, and reviews every result before committing. Eddie is pulled in only for demo-affecting judgment calls (cutting a feature, changing look or copy direction).

## Tiers

| Tier | Agent | Use for |
|---|---|---|
| top | `codex exec -s workspace-write -c model_reasoning_effort=high` (no GPU in its sandbox), or `agy -p --model claude-opus-4-6-thinking` (agy's own quota; can use the GPU) | State-dependent animation timing (unmount cleanup, interrupted transitions, cross-component sequencing); viewport-dependent layout math; shared state, render loop, scroll or pointer listeners; perf-sensitive motion; reduced-motion and focus management; bugs that are easy to introduce and hard to see (leaks, flicker, double-firing effects) |
| mid | `agy -p --model claude-sonnet-4-6`, `codex exec` at medium effort, or `agy -p --model gemini-3.8-flash-high --settings <allowlist>` | Self-contained component with a clear spec and no shared state; applying an already-chosen pattern to a new element; variants of something that works |
| low | `agy -p --model gemini-3.8-flash-low --settings <allowlist>` | Renames, class tweaks, copy, prop threading; stubs, imports, types; lint, formatting, dead code; repetitive generation from a template |

## Scores

- **Difficulty (D, 1 to 5)** sets the tier: 1 to 2 low, 3 mid, 4 to 5 top. Any top-tier trigger above forces top.
- **Failure cost (F, 1 to 5)** sets review depth, not the model. F >= 4 (demo-critical): screenshots in chromium and firefox at 1600x900 and 390x844, plus frame-time stats for anything animated. F 2 to 3: tsc, lint, build, and one screenshot. F 1: tsc, lint, build.

## Dynamic rules

- Until Eddie says the GPU is free: no performance runs and no headed browsers. Agents run Playwright headless only. Pending timings live in BENCHMARKS.md.

- Start cheap when clear-cut; if a low or mid output fails verification once, move it up a tier. Never retry the same tier twice.
- Demo relevance raises review, not the model.
- Re-score mid-flight: if a task turns out to touch shared state or the render loop, re-tier before the next agent picks it up.
- Split big tasks so only the hard piece goes to top tier; mechanical wiring goes cheaper.
- agy's Claude models share a separate quota that can run out (429 "Individual quota reached"); Gemini models kept working. Check git status after a quota failure: the agent may stop mid-edit.
- agy headless: `--mode auto` is not available on this account and it cannot prompt, so pass a per-session allowlist of command PREFIXES, no wildcards: `--settings '{"permissions":{"allow":["command(curl)","command(npx tsc)"]}}'`, and tell the agent to run single commands with absolute paths (no cd, pipes or &&). Never trust an agy claim that checks passed; the orchestrator reruns them.
- Parallel agents only on disjoint files (see `spec-common.md`). Agents never run git; the orchestrator commits.

## Tasks

| # | Task | Files | D | F | Tier | Escalations | State |
|---|---|---|---|---|---|---|---|
| 0 | Rebase branch on origin/main (46 commits behind; overlaps: backend/app/config.py, backend/app/main.py, frontend/src/api.ts, frontend/src/data/source.ts) | those 4 | 4 | 5 | orchestrator | 0 | deferred: no rebase until UI is polished (Eddie, 2026-11-14) |
| 1a | Orrery: remove panning, zoom toward centre only, +/- buttons, 0 resets (spec-f, HANDOFF item 1) | Orrery.tsx | 4 | 4 | top | 0 | done (codex high, one pass for 1a to 1c, 0 escalations) |
| 1b | Orrery: star and target positions from `useCatalog()`, any number of objects, clickable only with `preset_id` | Orrery.tsx, lib/catalog.ts | 4 | 4 | top | 0 | done (verified existing catalog wiring; 17-object test) |
| 1c | Orrery: radial scale and default zoom from research doc sections 4 and 5; no overlapping labels | Orrery.tsx | 5 | 5 | top | 0 | done; follow-up: labels crowd at 390x844 and when zoomed out (target labels over orbits) |
| 2 | Flight perf: p95 <= 17 ms, max <= 25 ms in chromium and firefox (spec-g); firefox is the problem | SkyBackdrop, Eyepiece, SkyStage, flight.ts | 5 | 5 | top | 0 | partial, committed (codex high). 60 Hz not reached; headless runs were software-rendered (SwiftShader/llvmpipe), so its numbers are unreliable. GPU measurement now works (see 2b) |
| 3a | Fix stale values in lib/targets.ts (Eps Indi B plx 274.99, RW Aur plx 5.4541, WISE 0855 2026 pos 133.7359, -7.2403) | lib/targets.ts | 1 | 4 | low | 0 | done 5a95a9a (agy). WISE 0855 2026 position reverted: it drops the view from 3 passes to 2, moved to 3b |
| 3b | WISE 0855 pass loss: root cause was catalog ref_epoch 2000 instead of 2010.33 (Gemini Flash High diagnosed, orchestrator verified; its views.py tolerance fix rejected as masking the bug). Fixed b1f9d51 (Gemini Flash Low). targets.ts WISE position 133.7599, -7.2422 was already right for 2026. Remaining optional: targets.ts facts read from the catalog | lib/targets.ts | 3 | 3 | mid | 0 | core done; catalog-driven facts optional |
| 5 | Gaia overlay: check whether main now fills `gaia` (PR #56 merged), then wire the rail and drawer | TBD after rebase | ? | 4 | rescore after 0 | 0 | blocked on 0 (rebase deferred) |
| 8 | UI identity research: space apps' palettes, components, 3D navigation; fix the too-glassy look | none (doc only) | 2 | 3 | mid: Gemini Flash High (research) | 0 | done: space-ui-research.md (reviewed; direction not adopted, see 9) |
| 9 | (superseded by 14) Polish pass: make panels feel part of the space scene (glass reads as a separate layer). No new features, no layout or feel change: tokens (blur, sheen, tinted borders), consistent radii, spacing, shadows across TopBar, step guide, Customize, rail, drawer, playback, dialogs | theme.css + component *.module.css | 3 | 4 | mid: Gemini Flash High; escalate to codex on one failed check | 0 | audit after task 2 lands |
| 10a | Real starfield data: tools/build_starfield.py + frontend/public/sky/bsc5.json (BSC5, V <= 6.5, static asset so no API-contract hotspot change) | new files only | 2 | 3 | mid: Gemini Flash High | 0 | done (8,404 stars, committed) |
| 2b | Flight hitch into a target: GPU Chromium shows 2 to 8 frames > 33 ms at specific moments (home flight about clean). Fix the spikes; apply task 2's Orrery recommendations (resize() resets the canvas bitmap ~10 times per flight; cache camera trig; build galaxy paths once per frame) | Orrery.tsx, SkyStage, SkyBackdrop, App.tsx flight wiring | 5 | 5 | top: codex high (re-split, isolated hitch) | 1 | after 12c, bundled with 10b |
| 10b | Render the real starfield (magnitude-sized, B-V coloured, batched by brightness) in Orrery background and SkyBackdrop, replacing skyStars(); no flight frame-time regression | Orrery.tsx, SkyBackdrop/*, lib/orbits.ts | 5 | 5 | top: codex high | 0 | after task 2 and 10a |
| 11 | Planets as shaded spheres lit from the Sun (terminator, Saturn rings), fading orbit trails (NASA Eyes style), planets move at about 1 day per second from today; readout shows the simulated date; 0 resets to now | Orrery.tsx, Orrery.module.css, lib/orbits.ts | 5 | 5 | top: codex high | 0 | running (codex high, headless); GPU check is BENCHMARKS B4 |
| 12a | Rebrand to "Into The Unknown" (brand.ts, index.html, dev.html titles) | those 3 | 1 | 4 | low: Gemini Flash Low | 0 | done a99dc8e |
| 12b | Dead-control audit across every screen and state (read-only) | none | 3 | 3 | mid: Gemini Flash High | 0 | done, verified (loading-state hides rejected: those controls work later on the same screen) |
| 12c | Remove dead controls per 12b, drop the "Sky context" label (keep the UTC clock), align the home zoom buttons with the rail and page margins, centre "Pick a target" | Toolbar, TopBar, SkyStage, Orrery, PlaybackBar, drawer | 4 | 5 | top: codex high (viewport layout) | 0 | done (one pass) |
| 13r | Research + diagnosis: continuous fly-to (van Wijk/Mapbox/Cesium/Eyes), every jump in our flight and drawer-resize timelines | none | 3 | 4 | mid: Gemini Flash High | 0 | done, verified against code |
| 13 | Rebuild flights in and home as one continuous move (no felt handoffs, image lands without shifting); lock eyepiece overlay and image together when the drawer opens and closes | flight.ts, Orrery, SkyBackdrop, SkyStage, App flight wiring | 5 | 5 | top: agy Opus 4.6 (needs GPU; codex sandbox cannot reach /dev/dxg). Also compass option A and removing the bottom-left status text | 0 | spec ready ~/scratch/t13; after 10c; codex high, done 660aae6 (boundary velocity jump 154x to about 2x the median, all < 3x); GPU check is BENCHMARKS B3 |
| 14r | Design options: compass alternatives, drawer reorganisation, playback bar in the home language, de-glass tokens, consistency rules | none | 3 | 4 | mid: Gemini Flash High | 0 | done; Eddie chose compass A, drawer as proposed, playback light touch |
| 14 | Implement the chosen 14r options + remove bottom-left release/passes text (replaces task 9) | theme.css, SkyStage, Drawer, PlaybackBar, Customize, Toolbar | 4 | 5 | mid: Gemini Flash High (agy Claude quota exhausted until ~08:00 UTC); escalate on one failed check | 0 | done b2ac653; small fixes 14b done (436dc6e drawer on Gemini Flash Low; scrim escalated to Gemini Flash High after a failed attempt, done); GPU check is BENCHMARKS B2 |
| 15 | Measured alignment audit across all screens and sizes (offsets, gutters, baselines), then fix list | none (audit) | 3 | 4 | mid: Gemini Flash High (Playwright, headless) | 0 | running |
| 10c | Starfield balance follow-up: stars clearly present but not overbearing; remove or fix the grey streak that reads as a fake Milky Way | Orrery, SkyBackdrop | 3 | 4 | escalated to top: codex high (Sonnet 4.6 attempt failed verification and hit agy quota mid-edit; reverted) | 1 | done b082731 (visual); Milky Way edge fix folded into 13; GPU check is BENCHMARKS B1 |
| 6 | Announce hotspot changes in team chat (App.tsx, package.json, main.py) | none | - | - | Eddie | - | todo |
| 7 | Remove or keep docs/handoff before merging | docs/handoff | 1 | 1 | low | 0 | at PR time |
