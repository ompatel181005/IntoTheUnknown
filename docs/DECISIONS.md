# Decisions

Append-only log, newest at bottom. Format: `## YYYY-MM-DD HH:MM - <title>` then Decision / Why / Owner.

## 2026-11-14 00:00 - Stack choice
Decision: Backend Python 3.11 + FastAPI in `backend/`. Frontend React + Vite + TypeScript in `frontend/`. Data watcher on Azure Functions (Python) in `functions/`. Infra scripts in `infra/`.
Why: Backend: the pipeline needs scientific Python (astropy, astroquery, reproject), per `infra/README.md`. Frontend and folder layout: TODO(team)
Owner: TODO(team)

## 2026-11-14 00:00 - Azure architecture
Decision: Azure Static Web Apps (frontend), Azure Container Apps (backend), Azure Blob Storage cache behind a CDN layer, Azure Functions timer trigger. Add-ons: Cosmos DB, Application Insights.
Why: Each resource solves a named problem; the table is in `infra/README.md`. The "CDN layer" part is superseded by the 12:45 entry below.
Owner: TODO(team)

## 2026-11-14 00:00 - MVP, tier, and cut scope
Decision: Scope split into MVP, Tier 2, Tier 3, and Cut as listed in `docs/IDEA.md`.
Why: 30 hours of build time. The MVP is what must work at the H12 gate (`docs/PLAN.md` §7); tiers set the order after it.
Owner: TODO(team)

## 2026-11-14 00:00 - Git workflow
Decision: Short-lived branches and PRs, any teammate other than the author reviews and merges, squash merge and delete branch, `main` must always run. Work split by feature slice, one owner per issue. GitHub Issues are the source of truth, STATUS.md is a snapshot. Parallel agents via worktrees.
Why: TODO(team)
Owner: TODO(team)

## 2026-11-14 12:45 - No CDN layer; frames served from Blob directly
Decision: Serve frames straight from a public-read Blob container. Front Door Standard is optional, Sunday only, deleted after local judging. Supersedes "Blob Storage cache behind a CDN layer" above.
Why: Classic Azure CDN has accepted no new profiles since Aug 15 2025, and Front Door Standard costs $35/month (`docs/PLAN.md` §1).
Owner: TODO(team)

## 2026-11-14 12:45 - Cut Durable Functions and Azure OpenAI
Decision: No Durable Functions. No Azure OpenAI; captions are deterministic templates filled with measured numbers.
Why: A ThreadPool already gives the 10× fetch speedup, so Durable Functions would be decorative. `AGENTS.md` §9 requires every number shown to users to come from our code.
Owner: TODO(team)

## 2026-11-14 12:45 - Target astrometry from Gaia DR3, not SIMBAD
Decision: Preset positions, proper motions and parallaxes come from Gaia DR3 and are propagated to the observation epoch. Never centre a view on J2000 or designation coordinates. SIMBAD is link-out only.
Why: SIMBAD/CDS was down on 2026-11-14, and J2000 coordinates are arcminutes off for the movers (Barnard's Star: about 4.6′). Values are in `docs/TARGETS.md`.
Owner: TODO(team)

## 2026-11-14 12:45 - SIA on the user path, TAP for the watcher and as fallback
Decision: User-facing frame queries use IRSA SIA. TAP is used by the watcher and when SIA fails.
Why: TAP queries took 20–37 s in the tutorials. The SIA index lags about a day, which the watcher's TAP check covers.
Owner: TODO(team)

## 2026-11-14 12:45 - Golden snapshots of the 5 targets ship with the frontend
Decision: Pre-computed manifests and arrays for the 5 targets are baked into `frontend/public/golden/`, and presets load from there first.
Why: IRSA's SIA and TAP returned 502 during planning. Judging must work with the API, IRSA or Blob down.
Owner: TODO(team)

## 2026-11-14 12:45 - Plan brought in line with the repo (docs PR)
Decision: `docs/PLAN.md` now follows `AGENTS.md`: folders `backend/ frontend/ functions/ infra/`, Python 3.11, `CUTOUT_MAX_WORKERS`, no full-frame downloads. Sleep moves to H13–19 and Tier 2 to H19–24. The pitch no longer promises auto-flagging (Tier 3); it promises the Gaia overlay (Tier 2). Auto-flag candidates need S/N > 10 in every epoch. The public API gets job and frame caps. Target data, citations, the resource table, the runbook and the code skeletons moved out of the plan into `TARGETS.md`, `DATA.md`, `infra/README.md` and `docs/skeletons/`.
Why: The plan contradicted the scaffolding, CI and its own cut list, and duplicated four template files that were still empty. The schedule change puts the lead differentiator after sleep, not at 01:00–06:00.
Owner: TODO(team)

## 2026-11-14 13:06 - Authors merge their own PRs
Decision: The author squash-merges their own PR once CI is green. No second reviewer is required. Supersedes "any teammate other than the author reviews and merges" in the Git workflow entry above. PRs, short-lived branches and "never commit to main" stay.
Why: Speed over safety for a 30-hour build. If main breaks, revert the merge via a PR first, then debug (`AGENTS.md` §11).
Owner: dflow11

## 2026-11-14 13:40 - Mask policy: don't let TRANSIENT/SUR_ERROR mask SOURCE pixels (spike #4)
Decision: In per-frame cleaning (PLAN §5.3), clear the TRANSIENT and SUR_ERROR bits on pixels that also carry SOURCE before masking. All other masking stays as written.
Why: A bright star's saturated core is flagged OVERFLOW + TRANSIENT + SUR_ERROR. Under the PLAN policy Barnard's Star was unmasked in only 4.1% of B1-B2 frames (SUR_ERROR masked 115 of 121), so the core went NaN in every stack. With the change it is unmasked in 98.3%, and the measured 1-yr shift matches Gaia to 0.033 px. Masking TRANSIENT everywhere would let cosmic rays through, so we only keep it on SOURCE pixels.
Owner: dflow11

## 2026-11-14 13:40 - Drop epochs with fewer than 10 frames (spike #4)
Decision: After `group_epochs`, drop epochs with fewer than 10 frames before channel-matched stacking, and report what was dropped.
Why: Barnard's B1-B2 grouping gave epochs of 37, 5, 36, 42 and 1 frames. The 5- and 1-frame epochs left no channel common to all epochs (`bandpass_matched=false`, 34-channel union). Without them it gives 3 epochs, 31 common channels and `bandpass_matched=true`.
Owner: dflow11

## 2026-11-14 13:40 - Measured centroid scatter replaces the 0.2 px estimate (spike #4)
Decision: Use the measured per-epoch field-star centroid scatter, 0.021 px per axis (11 Gaia stars, G 10-16, B1-B2 epoch stacks), in place of the estimated 0.2 px. Epoch-to-epoch shift scatter is 0.027 px per axis. Alignment offsets were at most 0.023 px, well under the 0.15 px re-reprojection threshold.
Why: The PLAN §5.8 candidate rule `max(0.5 px, 3 × scatter)` therefore floors at 0.5 px for bright stars. Scatter will be larger for faint sources, so keep computing it per view.
Owner: dflow11

## 2026-11-14 13:40 - IRSA facts confirmed live (spike #4)
Decision: Cutout `size` defaults to degrees and also accepts units (`0.1`, `0.1deg`, `6arcmin` and `360arcsec` all give 58 px). The backend must cap `size`, because `size=360` returned a full 2040×2040 frame. The `list_collections` column is `collection`, and the call is TAP-backed, so it fails whenever TAP is down; hard-code `spherex_dr1`/`spherex_qr3` as the fallback. A cutout is 4.02 MB, mostly the EPSF table. One cutout took 6.5 s from IRSA and 4.0 s from S3 range-reads; 121 cutouts with 10 workers took 199 s with no failures. The SIA `energy_bandpassname` value is `SPHEREx-D<n>` (detector), not a band name. IRSA SIA/TAP flapped between 200 and 502 within minutes.
Why: These are the open unknowns from PLAN §1 and §11.
Owner: dflow11

## 2026-11-14 13:20 - Challenge text and submission rules read (issue #3)
Decision: Facts from the challenge page and the Project Submission Guide, plus two scope **proposals** that are not yet applied to PLAN §7.
- Proposal 1, embedding: the challenge's "potential considerations" say coordinates in the URL let "users … easily embed it in other websites". URL state is already MVP. The proposal is to also allow framing, i.e. `staticwebapp.config.json` sends no `X-Frame-Options: DENY` and no restrictive `frame-ancestors`, with an optional minimal `?embed=1` layout. Docs PR #2 dropped embed from the plan (PR body; the 12:45 entries don't mention it). It's a consideration, not a requirement. TODO(team): confirm or reject. Apply nothing until then.
- Proposal 2, spectrum on click: move it later in the cut order (PLAN §7, currently cut 5th), below Front Door, because the challenge says "Extra kudos if your tool can generate spectra on the fly". TODO(team): confirm. PLAN §7 is unchanged until then.
- The challenge also lists, and we already cover: per-detector co-adds (band presets B1–B6), add/subtract across epochs (difference mode), user-chosen FOV, a Gaia overlay, coordinates in the URL, and contamination-flag metadata (the flag overlay is named in the challenge, so cut it late). WISE is only a WiseView link-out, not an overlay.
- Submission, per the guide (the live form isn't checked yet): demo is ≤30 s video or ≤7 slides (hard limit, otherwise ineligible for Global Judging). AI-generated code and data must be acknowledged in descriptive text and metadata, and AI images and video need a visible watermark. Checklist in PLAN §10.
Why: These come from the official pages, read in a browser on 2026-11-14, which were unread until now (PLAN §1 "Not verified").
Owner: ompatel (facts); the team confirms the two scope changes

## 2026-11-14 13:51 - Watcher finds new frames with SIA at fixed positions, not TAP MAX
Decision: The watcher asks SIA for the newest `t_min` at 7 positions: the north and south ecliptic poles plus the 5 pinned target centres (radius 0.01°, `TIME=<that position's stored newest − 2 d> +Inf`, 60 days back when nothing is stored). It pages from the newest `t_min` until a page brings nothing newer. The per-position times go into the version hash, not TAP `MAX(time_bounds_lower)` on `spherex.plane`. `list_collections` stays on TAP. The guarantee is narrower than "any new data": the watcher detects new releases (collections) and new frames at the poles and at the pinned views, not frames elsewhere on the sky. State lives in private `state/watcher.json`; `frames/meta/catalog.json` is a public projection of it. Partly supersedes "TAP for the watcher" in the 12:45 SIA/TAP entry.
Why: `time_bounds_lower` is unindexed (`TAP_SCHEMA.columns`), and the MAX query timed out at 120 s and 300 s. SPHEREx observes the poles continuously, so their newest frame tracks ingest; the pinned targets are what users actually load. Those SIA queries answer in 2–14 s. The SIA index lags ingest by about a day, which is fine for a daily watcher.
Owner: ompatel

## 2026-11-14 13:56 - Azure setup is scripted in infra/ and pinned to "Azure for Students"
Decision: `infra/00-preflight.sh`, `05-oidc-test.sh`, `10-core.sh` and `20-cost-alert.sh` replace the draft runbook's first steps. Names live in `infra/env.sh` with a fixed suffix (`SUF=itu7q4`). The subscription is pinned by ID and tenant from the git-ignored `infra/.env.local`, passed as `--subscription` on every call, and the scripts abort unless the name is "Azure for Students" (the UIC tenant also holds the university's "UIC-ACCC-WVD"). The CI identity gets AcrPush on the registry only; #23 adds a role scoped to the Container App. Region choice is pending the first preflight run.
Why: Surprises found while checking against Azure CLI 2.92.0: `az policy assignment list` defaults to `atExactScope()` and hides management-group policies, so the preflight uses `--filter "atScope()"`. Cost Management lists Azure for Students (MS-AZR-0170P) as unsupported, so the budget may need the portal fallback. `containerapp env create` changes its `--logs-destination` default in 2.93.0, so it is pinned. Students on a university tenant usually can't register apps, so GitHub OIDC probably falls back to GHCR plan B.
Owner: ompatel181005

## 2026-11-14 - Azure continuation: Blob frontend and server-side logging key
Decision: Prepare Blob static website hosting as the default (`SWA_LOC=none`); retain SWA only as an explicitly selected alternative when policy permits it. Claude's preflight recorded westus, northcentralus, norwayeast, belgiumcentral and francecentral as allowed, with no SWA overlap (issue #7). Run preflight again before creating resources. The app integrator chooses the reviewed public artifact directory and API endpoints; no frontend framework is imposed by these scripts.
Why: Microsoft's static website documentation confirms public static assets over HTTPS, but no custom headers or website CORS. An index error document returns 404, so use the app's query-string URLs. Blob hosting is billed for storage and traffic; it is not a guaranteed free replacement. https://learn.microsoft.com/en-us/azure/storage/blobs/storage-blob-static-website
Decision: Resolve the Log Analytics key inside ARM with `listKeys()` in `infra/containerapp-environment.json`. The installed CLI 2.92 parser leaves `--logs-workspace-key @-` as a literal string; do not fetch the real key locally to compensate. Microsoft's managed-environment template example uses workspace `listKeys()` for this configuration. https://learn.microsoft.com/en-us/azure/templates/microsoft.app/2024-03-01/managedenvironments
Validation: Offline scenarios exercise the actual Bash scripts against fake az/gh commands. They establish guard and error behavior, not cloud deployment success. Core creation, OIDC tenant permissions, budget creation and the public URL remain live gates under #7/#23. No billable resources were created during this continuation.
Owner: ompatel181005 (Codex continuation)
