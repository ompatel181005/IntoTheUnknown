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

## 2026-11-14 13:56 - Azure setup is scripted in infra/ and pinned to "Azure for Students"
Decision: `infra/00-preflight.sh`, `05-oidc-test.sh`, `10-core.sh` and `20-cost-alert.sh` replace the draft runbook's first steps. Names live in `infra/env.sh` with a fixed suffix (`SUF=itu7q4`). Every script selects `AZ_SUBSCRIPTION="Azure for Students"` and aborts on any other subscription (the UIC tenant also holds the university's "UIC-ACCC-WVD"). Region choice is pending the first preflight run.
Why: Surprises found while checking against Azure CLI 2.92.0: `az policy assignment list` defaults to `atExactScope()` and hides management-group policies, so the preflight uses `--filter "atScope()"`. Cost Management lists Azure for Students (MS-AZR-0170P) as unsupported, so the budget may need the portal fallback. `containerapp env create` changes its `--logs-destination` default in 2.93.0, so it is pinned. Students on a university tenant usually can't register apps, so GitHub OIDC probably falls back to GHCR plan B.
Owner: ompatel181005
