# Decisions

## 2026-11-14 - Explicit API telemetry and background operation measurements (#26)
Finding: The issue assumed an Application Insights startup hook, but the adopted app had none. The Azure connection string was also absent from the app template. The human explicitly approved the shared-file startup/dependency edits and deployment; the hook and pinned SDK dependency are now included.
Decision: Use the tested Azure Monitor SDK 1.8.12 behind an environment guard. Explicit server spans record route templates, HTTP status/duration and the ready-cache decision. Inflight reuse is not a ready-cache hit. Explicit dependency spans measure logical IRSA/S3/Gaia operations and background pipeline builds; retries are included within a logical operation. Propagate context to render/cutout/Gaia workers, rather than installing a global threading patch.
Surprises: The SDK defaults to rate-limited sampling and optional background collection/networking. Configure 100% tracing for this low-volume test deployment, exclude static assets/health, disable optional collection and offline disk buffering. FastAPI 0.163 also starts native spans when a global provider becomes active, even with the SDK's FastAPI instrumentation disabled. Its public telemetry configuration must disable native capture too; a real-SDK subprocess test verifies one request, one dependency, no secret marker and no network attempts.
Wiring: ARM resolves the existing Application Insights connection string into a Container Apps secret. A live ARM validation passed without deploying or retrieving the connection string locally. Runtime ingestion and workspace KQL remain live gates after merge: apply the ARM setup once with the provisioning identity, since the image-only CI workflow preserves existing secrets but does not create this reference. No broader CI permissions are added. No presentation measurements are claimed from the offline tests.
Sources checked: https://learn.microsoft.com/en-us/python/api/overview/azure/monitor-opentelemetry-readme and https://fastapi.tiangolo.com/advanced/opentelemetry/ . Workspace queries and scope/coverage limits are in infra/README.md and infra/telemetry/.
Owner: ompatel181005 (Codex)

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

## 2026-11-14 - Bound live cutout reads and release download buffers (#57)
Incident: The public app reported `PIPELINE_ERROR` with `Errno 28` while building a view. After the later deployment, the active container had about 3 GB free and no files in `/tmp`; the previous replica's disk contents were no longer available. The historical cause therefore remains unconfirmed.
Finding: An isolated local HTTP reproduction of `fits.open(url, cache=False, memmap=False)` left three Astropy temporary downloads after three FITS handles closed. They survive until Python exits, so repeated live views can accumulate downloads in a long-running API.
Decision: Read each IRSA cutout into memory with an 8 MiB transfer limit, close the response and buffer deterministically, and use `IRSA_TIMEOUT_S`. Keep the existing transient retries and S3 range fallback. The bound matches the existing capture downloader; no full-frame reads or new astronomy downloads are needed to test it. This addresses the reproduced leak, not eviction of rendered views or admission limits owned by the cache/job slices.
Verification: The official IRSA cutout documentation still specifies position/size query parameters (https://irsa.ipac.caltech.edu/data/SPHEREx/docs/cutout_tool.html). Azure documents 4 GiB of ephemeral storage for a replica with up to 1 vCPU and distinguishes it from durable storage (https://learn.microsoft.com/en-us/azure/container-apps/storage-mounts). Astropy documents that uncached downloads are temporary files cleaned up at process exit (https://docs.astropy.org/en/stable/api/astropy.utils.data.download_file.html).
Owner: ompatel181005 (Codex)

## 2026-11-14 15:00 - Adopt the SPHEREx Blink prototype as the app (proposal)
Decision: Merge the `initialammar` prototype (single `index.html` app, stdlib `server.py` proxy, `demo/` pack of real cutouts for the 5 targets, `tools/fetch_demo.py`, Playwright tests) into main as the product. Supersedes the React + Vite + TS frontend and the FastAPI server-side pipeline in the 00:00 "Stack choice" entry and PLAN §4–5, if the team confirms. Files stay at the repo root for now; `demo/` plays the role of `frontend/public/golden/`.
Why: main has no app code yet (docs, watcher, spike script only); the prototype already covers the whole MVP and most of Tier 2 (Gaia overlay, light curve, click spectrum, flags, 3-colour, difference, embed) with ~25 h to go. Open alignment gaps are listed in the PR body.
Owner: dflow11 (team to confirm)

## 2026-11-14 16:30 - The app is Eddie's React frontend + FastAPI backend
Decision: `eddie/ui-layout` (React + Vite + TS in `frontend/`, FastAPI in `backend/`) is the app, as in the original 00:00 "Stack choice" and PLAN §4. Supersedes the 15:00 "Adopt the SPHEREx Blink prototype" entry. The prototype's `index.html`, `server.py` and its Playwright tests are removed (in git history: PRs #37–#42). `demo/` and `tools/fetch_demo.py` stay: the backend builds the 5 presets from `demo/`, which covers the golden-snapshot decision without `frontend/public/golden/`. One container (Dockerfile) runs FastAPI, which also serves `frontend/dist`.
Why: the team chose Eddie's frontend. His backend already reads FLAGS by `MSKN` name, applies the spike #4 mask policy, queries SIA before TAP, and limits cutouts through the FOV enum, so the prototype fixes from PRs #40–#42 carry over. Open gap: no Gaia overlay yet (`extras.gaia` is null); PR #36's `gaia.py` is the piece to wire in.
Owner: dflow11

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

## 2026-11-14 16:30 - Deploy the combined app, with a bounded build context (#7/#23)
Decision: Supersedes the Blob-default frontend decision. FRONTEND_HOST defaults to container, matching main's React + FastAPI Dockerfile. Blob and SWA remain explicit alternatives. 30-app.sh defaults to a no-cloud-call plan; apply builds a resolved Git commit remotely in ACR, waits for build success, assigns registry-scoped AcrPull to the app identity, and exposes port 8000 with zero-to-one replicas. Job state currently lives in one process. No registry admin password is used.
Security: git archive stages tracked source only; .dockerignore permits only the production build inputs and excludes private/generated content. Azure CLI 2.92 help confirms the identity, ingress and build flags. ARM-token authentication is a managed-identity prerequisite and is checked before build (Microsoft documentation: https://learn.microsoft.com/en-us/azure/container-apps/managed-identity-image-pull). MSYS path conversion stays disabled for resource IDs; local upload/template paths are explicitly converted for Windows CLI.
Limits: Offline checks establish script guards, not live deployment. Core creation, ACR build, public revision readiness, cost/credit and OIDC remain live gates. Golden snapshots cover API failure while the host is reachable, not a host outage or cold start. Blob cache persistence, Function deployment/refresh integration and application telemetry instrumentation remain separate work; creating resources does not establish those integrations. No billable resources have been created by this continuation.
Owner: ompatel181005 (Codex)

## 2026-11-14 - Captured Barnard data tested in the adopted app (#27)
Decision: Reuse `tools/fetch_demo.py` to slim the 121 local B1-B2 cutouts into the adopted app's demo-pack format, preserving WCS, named FLAGS and ZODISUB. Use exposure stems as filenames to avoid rounded-MJD collisions. The new B1-B2 files are 2.38 MB; retain the 36 existing D3-D6 cutouts so other wavelength controls remain usable. The raw capture remains outside Git.
Validation: Independent Astropy/Gaia predictions were compared with Gaussian centroids fitted to the actual browser reprojections and median stacks, with archive access blocked. With D1 and D2 selected and max-per=10, the measured first-to-last motion is 1.679 px, predicted 1.659 px, vector error 0.078 px. Full B1-B2 capture (max-per=40) passes at 0.108 px; default max-per=3 fails at 0.304 px. Recommend D1-D2 at 10 for this target; this PR does not change the UI default. Detailed results, limitations and screenshots are in `validation.md` and `docs/validation/`.
Limits: This is conditional Barnard astrometry validation, not calibrated saturated-star photometry, wavelength-matched variability or validation of the other four targets. The epoch grouping and image combination are those of the adopted app. IRSA cutout request format was rechecked against https://irsa.ipac.caltech.edu/data/SPHEREx/docs/cutout_tool.html before retrying the seven failed cutouts; all seven were recovered with no full-frame requests.
Owner: ompatel181005 (Codex)

## 2026-11-14 16:30 - Validate integrated stacks and bundle real golden snapshots (#27)
Decision: Supersedes the legacy max-per settings above. Dense saved captures use the live ten-frame epoch floor when at least two epochs meet it; sparse demo packs retain their existing fallback. Query keys include the pipeline version and a selection-rule version so old pointers rebuild. Barnard now uses 37/36/42 cutouts in three matched epochs, with 0.0410 px motion-vector error and 0.1704 px maximum positional residual (PASS). Including its thin five-frame tail failed at 0.2765 px.
Decision: Export all five preset manifests, float arrays and masks from the real backend into frontend/public/golden. Validate byte equality against fresh backend outputs and the production build. All five React presets load with every API request denied; spectrum and brightness resolve a backend view only on demand and return 37/115 Barnard points with the API running. Coordinates must match the preset before using its snapshot.
Limits: API-independent images still require the web host. Only Barnard astrometry is validated; saturated photometry, the other targets and variability/discovery sensitivity are not. Main's field-star scaling (#45, pipeline version 2) is included. Current measurements and evidence are in validation.md and docs/validation/integrated.json; prior prototype evidence is archived separately.
Owner: ompatel181005 (Codex)

## 2026-11-14 17:45 - Alignment check runs on every saved view (#15)
Decision: `backend/app/processing/align.py` compares Gaussian-fit centroids of Gaia field stars (G <= 16.5, pm < 100 mas/yr, parallax < 20 mas, no comparable neighbour within 3 px) with their pm-propagated positions in each epoch stack. A mean offset over 0.15 px shifts that epoch's CRPIX and re-reprojects it. The manifest gains `astrom_resid_px` (per-axis centroid scatter), `astrom_offset_px` and `astrom_stars` per epoch; fewer than 4 usable stars gives null. Stars come from the demo pack's `gaia.csv`; live views report null until the Gaia query of #8 lands. `PIPELINE_VERSION` is 3 and the golden manifests are re-exported (the arrays are byte-identical, since no epoch needed correcting).
Why: Measured on the presets: Barnard 0.021-0.030 px scatter from 10-11 stars with offsets up to 0.021 px, matching spike #4. Eps Ind B 0.04-0.12 px (4-5 stars), RW Aur 0.07-0.14 px (5-7 stars), WISE 0855 0.05 px in two epochs and null in the third, R Dra null (2 frames per epoch). No preset exceeds 0.15 px. `docs/validation/integrated.json` still records pipeline version 2 and needs a rerun of `scripts/validate_integrated.py`.
Owner: dflow11
## 2026-11-14 17:13 - Blob Storage provisioned and verified before app hosting (#7)
Decision: Provision rg-planetx and stplanetxitu7q4 in westus first to unblock the cache owner. Fresh location policy was checked at subscription and resource-group scope. The account is StorageV2 / Standard_LRS, HTTPS only, minimum TLS 1.2. frames permits anonymous blob reads; state is private. Shared-key authorization is disabled: use DefaultAzureCredential and scoped Storage Blob Data Contributor, not a connection string. The signed-in provisioning user has the data role; Himanshu's own role grant awaits his Azure identity.
Evidence: authenticated upload/delete succeeded in both containers. Anonymous frames GET returned 200 with exact bytes and immutable one-year Cache-Control. Anonymous access to an existing state blob returned 404. Browser GET CORS preflight passed. Temporary probes from both successful and interrupted tests were removed. Public endpoint and SDK configuration are recorded in infra/BLOB-HANDOFF.md.
Core: the reviewed 10-core.sh then created Log Analytics, workspace-based Application Insights, ACR and the Container Apps environment, reusing and verifying the storage account. Resource creation does not imply backend Blob integration, Function deployment, telemetry instrumentation or a verified public app. Future Functions must use identity-based storage because shared-key authentication is disabled.
Sources checked before provisioning: https://learn.microsoft.com/en-us/azure/storage/blobs/storage-blobs-introduction and https://learn.microsoft.com/en-us/azure/storage/blobs/assign-azure-role-data-access . Data-plane roles must be explicitly granted even to the storage creator.
Owner: ompatel181005 (Codex)

## 2026-11-14 - Live budget succeeded; ACR Tasks denied; GitHub image build approved (#7/#23)
Evidence: budget-planetx was created on rg-planetx with a $20 monthly amount and actual-cost alerts at 50/80/100 percent to the requested email. The script verified the amount, dates, recipients and enabled thresholds from the response. The student offer did not reject this budget request; the earlier unsupported-offer concern remains a fallback, not this run's result.
Evidence: az acr build uploaded the tracked, filtered 11 MiB source context but failed with TasksOperationsNotAllowed. No application revision was deployed. Local Docker/Podman is absent. The user explicitly approved adding .github/workflows/build-image.yml, which builds a reviewed main commit on GitHub and pushes to ACR using a short-lived registry token in an Actions secret; the secret is removed after the run. The registry admin account stays disabled. 30-app.sh gains --deploy-only with a registry digest check so deployment does not repeat the blocked build operation.
Access: the supplied Himanshu email had no matching existing Entra identity. No guest invitation or guessed role grant was made. Cache data access for his account remains pending a confirmed identity/object ID. Public frame reads and the provisioner's authenticated data operations are already verified.
Owner: ompatel181005 (Codex)

## 2026-11-14 - Public app deployed with a dedicated user-assigned identity (#23)
Decision: The user explicitly authorized merging #53 after its backend/frontend/functions/scripts CI checks passed. GitHub build 43654638715 built main commit 130e42b9138545ec9a856136ad41e5d1aa19df50 and pushed its image to private ACR. The short-lived registry secret was removed immediately after success.
Surprise: standard-environment CLI and REST PATCH updates repeatedly failed with ExpressSystemAssignedIdentityNotSupported; system registry authentication also failed. A full standard ARM create/update using dedicated user-assigned identity id-planetx-api succeeded. Use the user identity for registry pulls and runtime Blob access, with AcrPull on the project registry and Blob Data Contributor on the project account only. AZURE_CLIENT_ID selects it. Preserve this path in infra/containerapp.json rather than reverting to the failing SystemAssigned/PATCH path.
Evidence: public HTTPS health passed. Chrome loaded all five saved target snapshots with every API request denied, and Barnard spectrum/light-curve requests returned 37/115 points with the API available. No browser errors or external browser requests. A probe executed inside the deployed container acquired a managed-identity token, wrote/read/deleted private Blob state and printed only a success marker. The token never left the container. This demonstrates resource/auth wiring, not completion of the backend Blob cache implementation.
Access: the confirmed UIC identity for Himanshu was found uniquely and granted account-scoped Blob Data Contributor plus Reader. The original personal email had no match; no guest invitation was created. The requested budget alerts are configured and verified.
Sources: https://learn.microsoft.com/en-us/azure/container-apps/express-overview and https://learn.microsoft.com/en-us/rest/api/resource-manager/containerapps/container-apps/create-or-update?view=rest-resource-manager-containerapps-2024-03-01 . User-assigned identities are supported for runtime and registry access; ARM 2024-03-01 supports explicit environment and workload profile fields.
Owner: ompatel181005 (Codex)

## 2026-11-14 - Warm testing instance and automatic main deployment requested (#23)
Decision: The human identified coordinate/FOV/band changes as the slow path and explicitly requested one warm instance during testing. Live scale is min=1/max=1. Saved-data measurements were 5.569/0.710 s for first/repeat 4 arcmin B1-B2, 3.406/0.396 s for B1 at 6 arcmin, and under one second to reject an unsupported Saved FOV. Auto mode can still fetch outside the five saved fields; no new astronomy downloads were made for profiling. Recorded timings are in infra/saved-view-timings.json. Cache and job lifecycle code remain with their owners.
Decision: Extend the already approved build workflow for pushes to main: checks, offline snapshot refresh, OIDC login, Docker build/push, exact-digest deployment, health/preset checks and restoration of the previous image on verification failure. Use separate CI identity id-planetx-github, with main-only GitHub federation and project-resource roles. Configure Azure IDs in GitHub secrets and APP_MIN_REPLICAS=1. No long-lived password or bootstrap registry token is needed. Setup completed; first federated workflow run awaits merging/testing this workflow update.
Owner: ompatel181005 (Codex)
## 2026-11-14 13:31 - Gaia fallback is ARI Heidelberg TAP, not MAST
Decision: `query_gaia_cone` tries the ESA Gaia TAP, then ARI Heidelberg's TAP with the same ADQL. MAST is not used. POINT and CIRCLE carry `'ICRS'`, and results that hit MAXREC are refused.
Why: astroquery's `Catalogs.query_region(catalog="Gaia", version=3)` warns and silently returns Gaia DR2 (epoch 2015.5). ARI returned the same 1976 rows as ESA with identical values. ARI's ADQL parser rejects POINT/CIRCLE without `'ICRS'`. Both servers truncate CSV silently at MAXREC.
Owner: ompatel

## 2026-11-14 14:30 - Gaia results via VOTable; WISE 0855 anchored on CatWISE2020
Decision: `query_gaia_cone` requests VOTable and refuses any result with QUERY_STATUS=OVERFLOW or as many rows as MAXREC. WISE 0855 uses the CatWISE2020 position at MJD 57170 with literature pm and parallax.
Why: CSV gives no truncation signal and `TOP n` sets no OVERFLOW; both ESA and ARI set OVERFLOW at MAXREC (checked live). The designation-epoch guess for WISE 0855 was unverified; CatWISE documents its epoch, and the literature pm matches the independent AllWISE position (0.4") better than CatWISE's own pm (1.9").
Owner: ompatel

## 2026-11-14 23:30 - Live pixels come from the S3 mirror first; IRSA cutouts are the fallback
Decision: `fetch_all` tries the S3 range read before IRSA's cutout service. `s3fs` is now a backend dependency. The Gaia query runs beside the cutout download, not after it. Live views are thinned to 120 frames (`MAX_FRAMES_PER_VIEW`, was 300). The collection list is asked of IRSA at most once an hour (`query.collections`), with `spherex_dr1`/`spherex_qr3` as the fallback. The frame list still comes from IRSA SIA/TAP, so a full IRSA outage still blocks new positions.
Why: `s3fs` was never declared, so `fetch_s3` failed on import and returned nothing: the S3 fallback did not work in the deployed app, and every failed IRSA cutout cost about 12 s of retries first. Measured from a laptop, 10 workers, same 30 Barnard frames: IRSA cutouts 1.05 frames/s, S3 range reads 2.75 frames/s. One full live view (RA 150.0, Dec +2.2, 6 arcmin, B1-B2): main took 310.6 s and lost 7 of 53 frames while IRSA was flapping; this change took 32 s for 70 frames with none lost. The Gaia ESA endpoint timed out at 30 s in those runs, which is why it no longer runs after the download. 32 workers was slower than 10 on S3, so `CUTOUT_MAX_WORKERS` stays at 10. Not yet timed from the Azure container.
Owner: dflow11

## 2026-11-15 00:30 - Blob render cache merged onto current main (#12)
Decision: Himanshu's two-level Blob cache (`backend/app/cache/blob.py`) is the render cache whenever `STORAGE_ACCOUNT_URL` is set: renders go to `frames/r/<rk>/`, pointers to `frames/q/<qk>.json`, and `manifest_url` is the public Blob URL, so the browser loads arrays from Blob. Unset, it is the local folder served at `/frames`, as before. Added while bringing the branch up to date: `gaia.json` is stored with the render and `/api/views/{id}/gaia` reads the render back through the cache (`read`); the Blob client retries once with 5 s connect and 20 s read timeouts; a failed Blob write keeps that view on local disk instead of failing it; every build renders, and only the upload is skipped when the render already exists.
Why: The container's disk is wiped on every deploy, so each custom position was rebuilt from the archive after every merge to main. Main gained the alignment check and the Gaia overlay after the branch was cut, and both wrote to or read from the local folder. Not tested against the real storage account before merging (no Azure CLI on the merging machine): the tests use a fake container, and the first real check is the deployed app.
Owner: Himanshu-1804 (cache), dflow11 (merge onto main)


## 2026-11-15: watcher activation uses MI storage and Flex OneDeploy (#7)

The activation template reuses project storage/Insights, adds a dedicated watcher
user identity and private host/package containers, and limits Flex to Python3.11,
2048MB/max2/no always-ready. Host Blob Data Owner is scoped to precreated host
containers; state/frames/package receive Blob Data Contributor. Container-scoped
host startup remains a live verification gate. A dedicated main-only code workflow
receives Website Contributor only on the Function app through the existing OIDC
identity, plus Reader on the watcher plan because Azure CLI
[reads its SKU before deploying](https://github.com/Azure/azure-cli/blob/azure-cli-2.92.0/src/azure-cli/azure/cli/command_modules/appservice/custom.py#L733-L760).
No subscription/RG role or storage shared key is added.

Current official migration guidance allows maximumInstanceCount 1-1000, although
an older ARM quickstart still has minimum40. The provider accepted 1, but protected
calls returned platform503; at 2 the handler executed and reported IRSA_DOWN.
Keep max2 with zero always-ready instances. This is an operational observation,
not a load test. Official Flex guidance explicitly supports config-zip remote builds
through OneDeploy without local Core Tools. References, exact commands and live
gates are in [WATCHER-ACTIVATION.md](../infra/WATCHER-ACTIVATION.md).

The shared refresh secret is generated/recovered only in memory and passed as a
secure ARM parameter/CAsecretRef/Function setting. Full manual API deployment
preserves it; unwired bootstrap initializes safely, while withheld/dangling keys
or cross-app disagreement fail closed. A refresh202 is accepted work, not proof
of completed frames; the existing watcher targets metadata plus five pinned Live
views, not all47 catalog renders. The host is provisioned and both functions are
indexed. Authentication rejection checks pass; a successful metadata refresh is
still pending upstream IRSA availability.
Owner: ompatel181005 (Codex)

## 2026-11-15: readable files in the Functions deployment ZIP (#7)

The first package built and uploaded but logged "Zip permission validation failed"
and could not index its functions. CPython's string-name `ZipFile.writestr`
[defaults to 0600](https://github.com/python/cpython/blob/3.11/Lib/zipfile.py#L1716-L1735).
Package runtime files explicitly as Unix regular files with mode0644. After this
fix OneDeploy succeeded and both functions indexed. No storage role was widened.
The regression test inspects the actual ZIP entries. Remote Linux build remains
enabled; only committed runtime files are packaged.
Owner: ompatel181005 (Codex)
