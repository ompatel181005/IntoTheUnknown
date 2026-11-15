# Azure deployment

The production Dockerfile builds React and runs FastAPI on port 8000. The default host is one Azure Container App serving the UI, `/api`, `/frames` and bundled `/golden` snapshots from the same origin. Live core provisioning was completed on 2026-11-14: `rg-planetx`, storage, monitoring, ACR and the Container Apps environment exist in westus. Application deployment is tracked separately below; offline script tests alone do not prove a live deployment. See [BLOB-HANDOFF.md](BLOB-HANDOFF.md) for the tested cache endpoint and access requirements.

## Resources and limits

| Resource | Purpose | Integration |
|---|---|---|
| ACR + Container Apps environment + app | Build and host the combined app | Live app verified; ACR Tasks denied, GitHub build succeeded |
| User-assigned identity | Registry pulls and runtime Blob access | `id-planetx-api`; scoped AcrPull and Blob Data Contributor; runtime Blob test passed |
| Log Analytics | Container platform logs | Workspace created and linked to the environment |
| Application Insights | API latency, ready-cache hits and archive operation failures | Opt-in instrumentation and KQL in #26; live verification required after activation |
| Blob Storage | Persistent render cache and watcher state | Live account and containers verified; backend integration belongs to #12 |
| Functions + dedicated watcher identity + private host/package containers | Metadata watcher and five pinned Live refresh requests | Reviewed FC1 activation/template and scoped OIDC code deployment; [activation runbook](WATCHER-ACTIVATION.md); live host verification pending |
| Blob website / Static Web Apps | Alternative frontend hosts | Off by default; SWA blocked by recorded region policy |

Cosmos DB and Front Door are outside this deployment. Golden snapshots let presets render when API requests fail **while the web host remains reachable**. They do not cover host outages or cold starts. Measurements require the API. Maximum replicas stays at one while jobs live in process memory. Local render cache can disappear on restart.

## Prerequisites

Use Git Bash or Cloud Shell with Git, tar, curl and Azure CLI; GitHub CLI is optional for OIDC. ACR builds remotely, so local Docker is unnecessary. Authenticate with `az login`. Put these IDs in ignored `infra/.env.local`:

```text
AZ_SUBSCRIPTION_ID=<guid>
AZ_TENANT_ID=<guid>
```

Never post that file, tokens, connection strings or keys. Every script verifies subscription ID, tenant and the name `Azure for Students`; calls are explicitly pinned. Never use the university-managed subscription. `env.sh` disables MSYS argument conversion for resource IDs and explicitly converts local file paths for Windows Azure CLI.

## Execution order

Have another teammate review and merge the Azure and integrated-validation PRs, then fetch `origin/main`. Deployment requires the selected commit to contain `.dockerignore` and the Barnard golden manifest.

```bash
bash infra/check-scripts.sh
bash infra/tests/run.sh
bash infra/30-app.sh --plan          # default; no Azure calls
bash infra/00-preflight.sh           # provider registration; otherwise read-only
export LOC=westus SWA_LOC=none FRONTEND_HOST=container  # confirm fresh preflight
bash infra/10-core.sh                # creates billable core resources
ALERT_EMAIL=you@example.com bash infra/20-cost-alert.sh
SOURCE_REF=origin/main bash infra/30-app.sh --apply
```

The recorded 2026-11-14 preflight allowed westus, northcentralus, norwayeast, belgiumcentral and francecentral. Container Apps and Functions Flex were available; no SWA region overlapped. Rerun before creation. Core verifies region policy at subscription and resource-group scopes and checks existing locations, SKUs, TLS, HTTPS, CORS and workspace links. An unreadable policy blocks creation unless a human explicitly sets `ALLOW_UNVERIFIED_REGION=1` after checking it.

`30-app.sh --apply` checks core resources and ACR ARM-token authentication, archives a resolved Git commit, and submits tracked files to ACR. `.dockerignore` additionally permits only Dockerfile/backend/frontend/demo inputs and excludes private or generated files inside them. The archive is removed; the extracted local context remains for inspection. Image tags use the source commit. The app uses `id-planetx-api`, a dedicated user-assigned identity with AcrPull only on this registry and Blob Data Contributor only on this storage account. The explicit environment, identity, registry, storage variables and HTTPS ingress are deployed through `containerapp.json`. This follows [Microsoft's managed-identity image-pull flow](https://learn.microsoft.com/en-us/azure/container-apps/managed-identity-image-pull). RBAC propagation can delay pulls; rerunning the same commit is safe.

After deployment, check revision readiness, `/api/health`, all five presets and spectrum/brightness at the public URL. HTTP 200 health does not establish that IRSA is up or science is validated. Save the source SHA and verification results without secrets. Return minimum replicas to zero after judging; cold starts are expected.

## Automatic CI/CD

The `build-image.yml` workflow now runs for every push to `main`, with manual dispatch retained. It checks backend/frontend/functions/capture/infrastructure code, regenerates the five saved snapshots with archive access blocked, logs in through GitHub OIDC, builds and pushes a commit-tagged image, deploys its exact digest, then checks health and all five preset manifests. Verification failure attempts to restore the previous image. Deployments are serialized; a push superseded by newer main is built but not deployed.

One-time setup: `bash infra/06-ci-identity.sh` after core/app provisioning. This creates dedicated identity `id-planetx-github`, validates a federation restricted to this repository's main branch, and stores only Azure IDs in Actions secrets. It grants registry AcrPush/Reader, app-scoped Container Apps Contributor, Managed Identity Operator on the runtime identity, and environment Reader. It has no resource-group Contributor or Blob data role. The runtime identity remains separate. No client password or periodically refreshed ACR token is needed. [Microsoft's managed-identity federation guide](https://learn.microsoft.com/en-us/entra/workload-id/workload-identity-federation-create-trust-user-assigned-managed-identity).

Repository variable `APP_MIN_REPLICAS` is **1 during testing**, explicitly requested by the human; this keeps one instance warm and incurs compute charges. Set it to `0` to return future automatic deployments to scale-to-zero. Maximum replicas remains one while jobs live in process memory. CI login, deployment and rollback still need one live workflow verification after this update merges.

## Alternative hosts and legacy authentication

`05-oidc-test.sh` is the older app-registration alternative. Prefer `06-ci-identity.sh`, which uses an Azure-managed identity and does not require tenant app-registration permission. Do not run both against the same GitHub Azure ID secrets without deliberately choosing which identity should be active.

Set `FRONTEND_HOST=blob` explicitly to enable the storage static website, or `FRONTEND_HOST=swa SWA_LOC=<allowed-region>` if policy permits. These need a separate frontend deployment and API-origin configuration; `30-app.sh` deploys the combined container only. The build context is the repository root, so an old backend-only workflow is unsuitable.

## Cost and checks

ACR, builds, monitoring, storage, network and compute can incur charges. The $20 budget is an email alert, not a spending cap. Azure for Students may reject the budget API; exit 3 requires checking the Azure Sponsorships credit portal instead. No live cost or remaining-credit estimate is claimed.

The live budget API accepted `budget-planetx` on 2026-11-14: $20 monthly on `rg-planetx`, actual-cost email alerts at 50/80/100 percent to the requested address. Amount, period and enabled recipients/thresholds were verified in the API response. Cost reporting can lag; this does not measure remaining student credit.

## ACR Tasks restriction and approved build fallback

The first live `az acr build` failed with `TasksOperationsNotAllowed`. No app revision was deployed by that attempt. No local Docker/Podman builder is installed. The human approved `.github/workflows/build-image.yml` as a manual bootstrap fallback; it successfully built the first image on GitHub. The automatic OIDC workflow above supersedes that bootstrap authentication.

For that first bootstrap only, a short-lived ACR token was passed through stdin to an Actions secret and removed after the successful run. The new OIDC workflow does not depend on `ACR_BUILD_TOKEN`. Never print registry tokens or put them in files or command arguments. [Microsoft's token login documentation](https://learn.microsoft.com/en-us/azure/container-registry/container-registry-authentication#use-az-acr-login-without-docker-daemon).

For a manual infrastructure redeploy, `MIN_REPLICAS=1 SOURCE_REF=<built-full-sha> bash infra/30-app.sh --deploy-only` checks the existing image digest and uses the declared user-assigned identity without requesting another ACR build. Omit `MIN_REPLICAS=1` to use scale-to-zero outside testing; automatic deployments use the repository variable above.

## Verified public deployment

Live URL: https://ca-planetx-api.politesand-6f83d8b5.westus.azurecontainerapps.io

Image source: `130e42b9138545ec9a856136ad41e5d1aa19df50`. The [GitHub build](https://github.com/ompatel181005/IntoTheUnknown/actions/runs/43654638715) succeeded and its temporary ACR secret was deleted. Health returned HTTP 200. Public Chrome checks passed for all five saved presets with every API request denied; normal API checks returned 37 Barnard spectrum points and 115 light-curve points. No browser errors or external browser requests occurred. [Recorded browser results](live-checks.json). These checks do not add science validation for the other targets.

CLI PATCH updates failed with `ExpressSystemAssignedIdentityNotSupported` despite the app referencing the standard Consumption environment. A full ARM create/update with a dedicated user-assigned identity succeeded. Runtime identity access to private Blob state was tested inside the deployed container. `30-app.sh` now uses this reproducible ARM/UserAssigned path. Keep maximum replicas at one until shared job state is implemented.

`check-scripts.sh` checks syntax, subscription/ARM URL scoping and workspace-key avoidance. `tests/run.sh` uses fake Azure/GitHub commands and fixture identities only, checking wrong-subscription/tenant refusal, policy, configuration, OIDC and budget behavior. Exit codes: 0 success, 1 error, 2 OIDC permission denial, 3 budget refusal, 4 unconfirmed policy.

## Application telemetry (#26)

`backend/app/telemetry.py` opts in only when `APPLICATIONINSIGHTS_CONNECTION_STRING` is set. The app startup hook and dependency must be installed before activation. `30-app.sh --deploy-only` resolves the existing Application Insights connection string inside ARM into a Container Apps secret and references it from the environment; no connection string is retrieved locally or passed in command arguments. Image-only automatic deployments preserve this configuration.

The module records method, route template, HTTP status, duration and the actual cache decision for API requests. It excludes health checks and static snapshots. `cache.hit=true` means a ready in-memory or local render was reused; an already-running job is `false` / `pending`. Invalid requests can have no cache tag; the query reports tag coverage instead of silently counting them as misses. Static golden views bypass `/api/views`, so this is an API cache ratio, not a website-wide hit ratio.

IRSA queries/cutouts, S3 cutouts and Gaia cone queries are logical dependency operations, including retries/fallback within an operation. A returned failed cutout is an error even when its caller recovers through S3. The `pipeline.build` dependency measures background build time; HTTP POST latency alone only measures submitting the job. Thread context links work to its originating request. These counts are not individual network-request counts. Saved builds do not make archive calls, so zero IRSA/S3/Gaia operations during saved-only testing is expected.

Automatic request/dependency capture and FastAPI's native telemetry are disabled: spans omit URLs, query strings, coordinates, headers, bodies, client addresses and exception text/stacks. Exceptions record their class only. The tested Azure SDK is pinned to 1.8.12. Optional control-plane/Statsbeat/resource-discovery calls, metrics and log export default off. Live metrics, performance counters and offline disk buffering are disabled; an ingestion outage can drop telemetry rather than fill the app disk. The low-volume testing configuration requests 100% trace sampling, while KQL uses `ItemCount` weights and reports null percentages/latencies when there are no observations. Explicit sampler/environment overrides can still affect coverage.

Run these files in the **log-planetx workspace** Logs view:

- [requests.kql](telemetry/requests.kql): represented view requests, cache-tag coverage, ready-cache hits and weighted p50/p95 latency in milliseconds.
- [dependencies.kql](telemetry/dependencies.kql): represented logical operations, failures and weighted p95 duration, including explicit zero-count services.

For **appi-planetx resource** Logs (the PLAN section 10 examples), use `requests`/`dependencies`, `timestamp`, `cloud_RoleName`, `customDimensions`, `itemCount`, `name`, `duration / 1ms` and `tobool(success)` in place of the workspace names. Do not mix the two schemas. [Microsoft's schema mapping](https://learn.microsoft.com/en-us/azure/azure-monitor/app/data-model-complete), [AppRequests](https://learn.microsoft.com/en-us/azure/azure-monitor/reference/tables/apprequests), [SDK options](https://learn.microsoft.com/en-us/python/api/overview/azure/monitor-opentelemetry-readme).

Verification procedure: run one supported Saved custom view and repeat it once ready; inspect the KQL results after ingestion. A first-build miss and ready repeat must be distinguishable. Use only returned measurements and record the observed UTC window. Dependency error/context behavior is tested with an in-memory exporter and mocked archives; do not generate synthetic production failures or download astronomy data to populate a presentation chart. All five saved snapshots must continue working with their API unavailable.

## View-loading observations

Saved-data timings from the public app are recorded in [saved-view-timings.json](saved-view-timings.json): Barnard at 4 arcmin / B1-B2 took 5.569 s on first build and 0.710 s on repeat; B1 at 6 arcmin took 3.406 s then 0.396 s. A 10 arcmin Saved request returned NOT_SAVED in under one second. These observations are not a load test or a cold-start benchmark.

Default preset snapshots avoid backend rebuilding. Other supported coordinates/FOV/bands rebuild saved cutouts and then hit the render cache on repeat. Auto can contact the archive beyond the saved footprint; the downloads cover five fields, not the full sky. Use Saved to prevent live fallback while demonstrating the downloaded data. Persistent cache and job lifecycle improvements remain owned by #12/#13, rather than being duplicated in the deployment slice.
