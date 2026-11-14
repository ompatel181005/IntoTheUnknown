# Azure resources

Every resource must name the problem it solves. Remove any resource without one.

| Resource | Problem it solves | Tier | Status |
|---|---|---|---|
| Blob static website (`$web`) | Serves the UI and bundled target data over HTTPS without running Python. Presets work with the API down; a storage outage still affects the site. | MVP | prepared; not deployed by this change |
| Static Web Apps (optional alternative) | Frontend hosting if the tenant later permits an SWA region. | optional | blocked by current allowed-regions policy |
| Container Apps (+ ACR) | Heavy scientific Python (astropy, reproject) on scale-to-zero compute that holds long jobs. Min replicas set to 1 only during judging. | MVP | not created |
| Blob Storage (served directly, no CDN) | **Speed.** The first render of a view takes 30–60 s; a repeat load from Blob takes under 1 s. Also stores job state and catalog state. | MVP | not created |
| Managed identity | Removes storage secrets. It's a feature, not a resource. | MVP | not created |
| Functions (Flex Consumption) | **Freshness.** A daily catalog diff re-renders cached views when SPHEREx adds data. An HTTP "run-now" trigger lets us demo it live. | Azure track | not created |
| Application Insights | **Observability.** p50/p95 latency, IRSA dependency failures and cache-hit ratio. These are the numbers on the Azure slide. | Azure track | not created |
| Cosmos DB (free tier) | **Discovery.** A queryable board of community candidate reports. Only wired up if Tier 3 "Report" ships; it takes 5 minutes to create. | T3 | not created |
| Front Door Standard (optional) | Edge caching of immutable frames near viewers, plus a single domain. **Sunday only**, and delete it after local judging ($35/month). | optional | not created |

- **Azure track** = built in parallel by the Azure owner for the "Best Use of Azure" award. It is not an MVP gate item (`docs/PLAN.md` §7).
- **No CDN layer.** Classic Azure CDN accepts no new profiles, so frames are served from Blob directly (`docs/DECISIONS.md`).
- **Cut:** Durable Functions (a ThreadPool already gives the 10× speedup) and Azure OpenAI (captions are deterministic templates).

## How to run

Claude ran `00-preflight.sh` on 2026-11-14 against Azure for Students (issue #7). It registered providers; allowed regions were westus, northcentralus, norwayeast, belgiumcentral and francecentral. Container Apps and Functions Flex were available in those five; none supported Static Web Apps. This is a recorded preflight result, not proof of a current deployment. Rerun preflight before creating resources. Core creation, OIDC, budget alerts and a public website remain unverified.

The scripts verify existing settings before proceeding. Names live in `infra/env.sh`; the default frontend host is Blob static website (`SWA_LOC=none`). This works with a plain HTML app or a built React app, so it does not require a frontend rewrite.

**Prerequisites (once)**
- Azure CLI 2.92.0 or later: `winget install -e --id Microsoft.AzureCLI`, then open a **new** Git Bash so `az` is on PATH. Or use **Azure Cloud Shell** (Bash), which already has `az` and `gh`; clone the repo there.
- Call plain `az`. Calling `az.cmd` by its full path from Git Bash goes through cmd.exe, which breaks `--query` strings that contain `{}` or `|`.
- `az login`. The UIC tenant has two subscriptions. **"Azure for Students" is ours**; "UIC-ACCC-WVD" is university-managed, never touch it.
- Create `infra/.env.local` (git-ignored by `.env*`; check with `git check-ignore -v infra/.env.local`) with the "Azure for Students" IDs. They are not in git because the repo is public:
  ```
  AZ_SUBSCRIPTION_ID=<subscription guid>
  AZ_TENANT_ID=<tenant guid>
  ```
  Every script checks that `az account show --subscription $AZ_SUBSCRIPTION_ID` returns that id, that tenant and the name "Azure for Students", and aborts otherwise. Every subscription-scoped call passes `--subscription "$AZ_SUBSCRIPTION_ID"` (through `azs`/`azsq` in `env.sh`), so the CLI default never decides. `bash infra/check-scripts.sh` fails if a script calls a subscription-scoped command without it.
- `gh auth login` (as a repo admin) before `05-oidc-test.sh`, so it can set the Actions secrets. Without it, the script prints the `gh secret set` commands instead.

**Order** (from the repo root):

| # | Command | What it changes | Paste back on issue #7 |
|---|---|---|---|
| 1 | `bash infra/00-preflight.sh` | Registers resource providers only (idempotent, free). Everything else is read-only. | The block between the `=====` lines. It also goes in `docs/DECISIONS.md`. |
| 2 | `export LOC=westus SWA_LOC=none` | Nothing. Confirm the recommendation from the current preflight first. | — |
| 3 | `bash infra/05-oidc-test.sh` | App registration `gh-planetx-itu7q4` (appId saved to `infra/.env.local` as `AZ_OIDC_APP_ID`), federated credential for `main`, 3 GitHub secrets | "OIDC allowed", or "OIDC blocked → GHCR plan B" (exit code 2) |
| 4 | `bash infra/10-core.sh` | Creates billable resources: resource group, monitoring, storage (`frames` public read, `state` private), ACR and Container Apps environment. Enables the Blob website; creates SWA only if explicitly selected. | The "core resources" block (names and URLs only) |
| 5 | `bash infra/05-oidc-test.sh` again | AcrPush for the OIDC app on the registry (only once the registry exists) | — |
| 6 | `ALERT_EMAIL=you@example.com bash infra/20-cost-alert.sh` | $20/month budget on the resource group, email at 50/80/100 % of actual cost | The budget table it prints, or which fallback you used (exit code 3) |

- **Region.** Preflight exits 4 if it cannot confirm the location policy. Core creation refuses to proceed unless policy confirms the chosen region, checked at subscription scope and again at resource-group scope. After manual verification in the portal, `ALLOW_UNVERIFIED_REGION=1` explicitly overrides an unreadable policy. `SWA_LOC` defaults to `none`; set a region only if both Azure and the policy support SWA there.
- **Reruns** verify instead of trusting: if a resource exists with another location, ACR SKU, workspace link or blob public-access setting, `10-core.sh` stops with a clear message. CORS adds our rule only if an identical rule isn't there, and leaves other rules alone.
- Keep `SUF`, `LOC` and `SWA_LOC` the same on every run (export them once per shell). `SUF` is fixed in `env.sh`. Change it only if `10-core.sh` says a name is taken.
- Exit codes: 0 ok, 1 error, 2 OIDC blocked (use plan B), 3 budget API refused (use the portal fallback), 4 regions not confirmed (set `LOC` by hand).
- `05-oidc-test.sh` reports plan B only after a permission denial. Network and login failures exit 1 and need diagnosis. Tenant permissions have not been tested here. The script reuses only the saved app ID after an owner check, and checks the federated credential's subject, issuer and audience.
- `20-cost-alert.sh` may fail too: Azure for Students may not be supported for budgets. The script tries the API, and if it refuses, prints the portal fallback and the credit-balance link.
- The scripts never print keys or connection strings. `containerapp-environment.json` uses ARM `listKeys()` inside Azure to configure logging; it has no secret parameters or outputs. The Container App, Function app and Cosmos DB are not created here (#23, #24, T3).

**Offline checks** (no login or cloud traffic):
```bash
bash infra/check-scripts.sh
bash infra/tests/run.sh
```
The behavioral tests put fake `az` and `gh` commands first on PATH and use made-up IDs and temporary files. They cover subscription/tenant mismatch, region restrictions, storage TLS/HTTPS/SKU, reruns, OIDC repair and returned budget alerts. They cannot establish that Azure accepts the template or grants the required roles; first live creation remains a separate gate.

**Publishing the combined app (#23).** Stage only reviewed public assets in a dedicated folder, then upload that folder to `$web` using `--auth-mode login` and an explicitly pinned subscription. Never upload the repository root, `.git`, `.env`, Python source, private state or caches. Keep `state` private and grant upload permissions only to the deployment identity. Serve live archive traffic through a backend with request and download limits. The frontend integrator owns the artifact directory and endpoint configuration; this setup creates no dependency on React or FastAPI.

Blob static website limitations: contents are public, storage/traffic charges apply, custom response headers and CORS are not configurable on the website endpoint, and an error document still returns HTTP 404. Query-string URLs avoid SPA path fallback issues. Blob-service CORS above applies to the separate `frames` endpoint, not the website. See [Microsoft's static website documentation](https://learn.microsoft.com/en-us/azure/storage/blobs/storage-blob-static-website).

**Least privilege for CI.** The OIDC app gets **AcrPush on the registry only**, not Contributor on the resource group. TODO(#23): once the Container App exists, grant the app a role scoped to that Container App only (for `az containerapp update`), and Reader on the registry if `az acr login` needs it.

## Runbook for later issues (draft, not yet run)

Moved here from `docs/PLAN.md` §8. Steps 0–4, the environment in step 6 and the SWA in step 7 are now the scripts above. What follows is still a draft for #23 (Container App, deploys), #24 (Function) and T3 (Cosmos). Run it in Git Bash or Cloud Shell after `source infra/env.sh && require_sub` (that checks the IDs in `infra/.env.local` and sets them as the CLI default). When a block becomes a script, call subscription-scoped commands through `azs`/`azsq` (or add `--subscription "$AZ_SUBSCRIPTION_ID"`); `infra/check-scripts.sh` enforces it.

**Corrections to the original draft** (checked on 2026-11-14 against Azure CLI 2.92.0 `-h` and learn.microsoft.com):
- `SUF=$RANDOM` created new resources on every run. Names now come from `infra/env.sh` with a fixed `SUF`.
- Git Bash rewrites arguments that start with `/` (`--scope /subscriptions/...`) into Windows paths. `env.sh` sets `MSYS_NO_PATHCONV=1`.
- `az policy assignment list` without a filter sends `atExactScope()`, so a region policy inherited from a management group stays hidden. Use `--filter "atScope()"`.
- CLI 2.92.0 rejects `list-flexconsumption-locations --runtime python` without `--details`, while `--details` is unavailable there. The script lists Flex regions without that filter. Verify the runtime separately when deploying the Function.
- `az storage container create --auth-mode key` → `az storage container-rm create` (goes through ARM, needs no account key).
- `az storage cors add` (data plane, uses the account key) appends a rule on every run. The script uses ARM instead (`az storage account blob-service-properties show` / `cors-rule add`) and adds our rule only if an identical one is missing.
- The subscription was chosen by name and the CLI default. It is now pinned by ID and tenant from the git-ignored `infra/.env.local`, on every call.
- Environment logging is explicitly `log-analytics` in the ARM template. The CLI `--logs-workspace-key` string option does not read `@-` as stdin; use the template so no key is fetched locally. [Template reference and workspace example](https://learn.microsoft.com/en-us/azure/templates/microsoft.app/2024-03-01/managedenvironments).
- `ENV=cae-planetx` is renamed `CAE`: `ENV` is a special shell variable.
- The SWA is created without `--source`/`--login-with-github`, so no workflow or token is generated; the deploy pipeline is #23. Its `-l` was hard-coded to `westus2`. It must be an SWA region (`westus2, centralus, eastus2, westeurope, eastasia`) that the region policy also allows.
- OIDC: the display name is now unique (`gh-planetx-$SUF`) and the app is reused only by its saved ID, after an owner check. The role is AcrPush on the registry instead of Contributor on the RG. `--assignee $APP_ID` → `--assignee-object-id <SP object id> --assignee-principal-type ServicePrincipal`, which avoids Graph lookups and propagation errors on a new SP.
- `Microsoft.Cdn` is dropped from the provider list. Register it only before step 10 (Front Door).
- `az extension add -n containerapp` is optional: `containerapp env create` is in the core CLI. `application-insights` is still an extension; `10-core.sh` installs it.
- Cost alert: Cost Management's offer list marks Azure for Students as unsupported, so a budget may be impossible; the script tries anyway. The credit balance is on https://www.microsoftazuresponsorships.com/.

```bash
source infra/env.sh   # names, fixed SUF, MSYS_NO_PATHCONV; then load IDs (never echo AI_CONN)
SA_ID=$(az storage account show -g $RG -n $SA --query id -o tsv)
ACR_ID=$(az acr show -g $RG -n $ACR --query id -o tsv)
AI_CONN=$(az monitor app-insights component show -g $RG -a $AI --query connectionString -o tsv)

# 5. Cosmos DB (T3 only). Start early (5–10 min). Free tier must be chosen at creation; one per subscription
#    (00-preflight.sh reports whether it is already used).
az cosmosdb create -g $RG -n $COSMOS --enable-free-tier true \
  --locations regionName=$LOC failoverPriority=0 isZoneRedundant=False --no-wait

# 6. Container App (#23), after CI has pushed the first image; the app listens on 8000. $CAE exists (10-core.sh).
#    UNVERIFIED in #7: check these flags with -h in #23.
az containerapp create -g $RG -n $API --environment $CAE \
  --image $ACR.azurecr.io/planetx-api:bootstrap --registry-server $ACR.azurecr.io --registry-identity system \
  --target-port 8000 --ingress external --cpu 1.0 --memory 2.0Gi --min-replicas 0 --max-replicas 1 --system-assigned
#   (if the --registry-identity create fails: create with a public placeholder image, assign AcrPull, then
#    `az containerapp registry set -g $RG -n $API --server $ACR.azurecr.io --identity system`)
PRINCIPAL=$(az containerapp show -g $RG -n $API --query identity.principalId -o tsv)
az role assignment create --assignee-object-id $PRINCIPAL --assignee-principal-type ServicePrincipal \
  --role "Storage Blob Data Contributor" --scope $SA_ID
az role assignment create --assignee-object-id $PRINCIPAL --assignee-principal-type ServicePrincipal \
  --role AcrPull --scope $ACR_ID
REFRESH_KEY=$(openssl rand -hex 24)
az containerapp secret set -g $RG -n $API --secrets appi-conn="$AI_CONN" refresh-key="$REFRESH_KEY"
API_URL=https://$(az containerapp show -g $RG -n $API --query properties.configuration.ingress.fqdn -o tsv)

# 7. Static Web App: $SWA exists (10-core.sh) with no GitHub wiring. #23 deploys with its deployment token,
#    stored as a GitHub secret and never printed (UNVERIFIED query path, check in #23):
#    az staticwebapp secrets list -g $RG -n $SWA --query properties.apiKey -o tsv
SWA_HOST=$(az staticwebapp show -g $RG -n $SWA --query defaultHostname -o tsv)
az containerapp update -g $RG -n $API --set-env-vars \
  STORAGE_ACCOUNT_URL=https://$SA.blob.core.windows.net FRAMES_CONTAINER=$FRAMES_CONTAINER STATE_CONTAINER=$STATE_CONTAINER \
  FRAMES_PUBLIC_BASE=https://$SA.blob.core.windows.net/$FRAMES_CONTAINER \
  APPLICATIONINSIGHTS_CONNECTION_STRING=secretref:appi-conn REFRESH_KEY=secretref:refresh-key \
  ALLOWED_ORIGINS=https://$SWA_HOST,http://localhost:5173 CUTOUT_MAX_WORKERS=10 IRSA_TIMEOUT_S=120 PIPELINE_VERSION=1

# 8. Watcher Function (#24): Flex Consumption, Python 3.11 (flags checked against the Flex how-to)
az functionapp create -g $RG -n $FUNC --storage-account $SA --flexconsumption-location $LOC \
  --runtime python --runtime-version 3.11 --app-insights $AI
az functionapp identity assign -g $RG -n $FUNC
FPRIN=$(az functionapp identity show -g $RG -n $FUNC --query principalId -o tsv)
az role assignment create --assignee-object-id $FPRIN --assignee-principal-type ServicePrincipal \
  --role "Storage Blob Data Contributor" --scope $SA_ID
az functionapp config appsettings set -g $RG -n $FUNC --settings \
  API_BASE=$API_URL REFRESH_KEY=$REFRESH_KEY STORAGE_ACCOUNT_URL=https://$SA.blob.core.windows.net
(cd functions && func azure functionapp publish $FUNC)
#   Fallback if Flex is unavailable in LOC (00-preflight.sh says so): same code as a Container Apps Job
#   az containerapp job create -g $RG -n job-watcher --environment $CAE --trigger-type Schedule \
#     --cron-expression "0 6 * * *" --image $ACR.azurecr.io/planetx-api:<sha> --command python -m app.watch ...

# 9. Cosmos containers (when step 5 finishes)
az cosmosdb sql database create -g $RG -a $COSMOS -n planetx --throughput 400
az cosmosdb sql container create -g $RG -a $COSMOS -d planetx -n candidates --partition-key-path /hpx5
COSMOS_KEY=$(az cosmosdb keys list -g $RG -n $COSMOS --query primaryMasterKey -o tsv)
az containerapp secret set -g $RG -n $API --secrets cosmos-key="$COSMOS_KEY"
az containerapp update -g $RG -n $API --set-env-vars \
  COSMOS_ENDPOINT=https://$COSMOS.documents.azure.com:443/ COSMOS_KEY=secretref:cosmos-key COSMOS_DB=planetx

# 10. (Optional, Sunday) Front Door Standard in front of the frames container. Delete it after local judging.
az provider register -n Microsoft.Cdn --wait
az afd profile create -g $RG --profile-name afd-planetx --sku Standard_AzureFrontDoor
az afd endpoint create -g $RG --profile-name afd-planetx --endpoint-name frames-$SUF --enabled-state Enabled
az afd origin-group create -g $RG --profile-name afd-planetx --origin-group-name blob \
  --probe-request-type HEAD --probe-protocol Https --probe-interval-in-seconds 240 --probe-path /frames/meta/catalog.json \
  --sample-size 4 --successful-samples-required 3 --additional-latency-in-milliseconds 50
az afd origin create -g $RG --profile-name afd-planetx --origin-group-name blob --origin-name sa \
  --host-name $SA.blob.core.windows.net --origin-host-header $SA.blob.core.windows.net \
  --http-port 80 --https-port 443 --priority 1 --weight 1000 --enabled-state Enabled
az afd route create -g $RG --profile-name afd-planetx --endpoint-name frames-$SUF --route-name frames \
  --origin-group blob --supported-protocols Https --https-redirect Enabled --forwarding-protocol HttpsOnly \
  --link-to-default-domain Enabled --patterns-to-match "/*" --enable-caching true --query-string-caching-behavior IgnoreQueryString
# then set VITE_FRAMES_BASE=https://<afd-endpoint-host>/frames and redeploy the frontend

# Judging days: no cold starts
az containerapp update -g $RG -n $API --min-replicas 1      # set back to 0 afterwards
```

**GitHub OIDC for CI.** `infra/05-oidc-test.sh` does this idempotently: app registration `gh-planetx-itu7q4` (appId kept in `infra/.env.local`), federated credential with subject `repo:ompatel181005/IntoTheUnknown:ref:refs/heads/main` (issuer `https://token.actions.githubusercontent.com`, audience `api://AzureADTokenExchange`), AcrPush on the registry, then the GitHub secrets `AZURE_CLIENT_ID`, `AZURE_TENANT_ID` and `AZURE_SUBSCRIPTION_ID`. The `az containerapp update` step in the workflow below needs a role on the Container App, which #23 grants once the app exists. If the tenant blocks app registration, use **plan B**: CI pushes a public image to GHCR (`ghcr.io/ompatel181005/planetx-api:<sha>`, built-in `GITHUB_TOKEN` with `packages: write`), and a laptop or Cloud Shell runs `az containerapp update -g rg-planetx -n ca-planetx-api --image ghcr.io/ompatel181005/planetx-api:<sha>`. That needs no Azure secrets in GitHub and no local Docker.

`.github/workflows/api.yml` (a hotspot: the infra owner adds it in #23, ask the human first):
```yaml
name: api
on: { push: { branches: [main], paths: ["backend/**"] }, workflow_dispatch: {} }
permissions: { id-token: write, contents: read }
jobs:
  deploy:
    runs-on: ubuntu-latest
    env: { ACR: acrplanetxitu7q4, RG: rg-planetx, APP: ca-planetx-api }
    steps:
      - uses: actions/checkout@v4
      - uses: azure/login@v2
        with: { client-id: "${{ secrets.AZURE_CLIENT_ID }}", tenant-id: "${{ secrets.AZURE_TENANT_ID }}", subscription-id: "${{ secrets.AZURE_SUBSCRIPTION_ID }}" }
      - run: az acr login -n $ACR
      - uses: docker/setup-buildx-action@v3
      - uses: docker/build-push-action@v6
        with: { context: backend, push: true, tags: "${{ env.ACR }}.azurecr.io/planetx-api:${{ github.sha }}" }
      - run: az containerapp update -g $RG -n $APP --image $ACR.azurecr.io/planetx-api:${{ github.sha }}
```
For the default Blob website, #23 uploads only the frontend artifact directory to `$web`, and configures the actual API and frames endpoints used by the combined app. If SWA becomes available and is explicitly selected, #23 can instead use its deployment workflow. The YAML above is a draft for the originally proposed backend; reconcile it with the integrated app before creating a workflow.

**Environment variables:**
- **API:** `STORAGE_ACCOUNT_URL`, `FRAMES_CONTAINER`, `STATE_CONTAINER`, `FRAMES_PUBLIC_BASE`, `APPLICATIONINSIGHTS_CONNECTION_STRING`, `REFRESH_KEY`, `ALLOWED_ORIGINS`, `CUTOUT_MAX_WORKERS`, `IRSA_TIMEOUT_S`, `PIPELINE_VERSION`, `COSMOS_ENDPOINT`, `COSMOS_KEY`, `COSMOS_DB`
- **Watcher:** `API_BASE`, `REFRESH_KEY`, `STORAGE_ACCOUNT_URL`, plus `AzureWebJobsStorage` and App Insights, which Flex sets automatically.
- **Web** (build time): `VITE_API_BASE`, `VITE_FRAMES_BASE`

**Cost.** No live cost or remaining-credit measurement has been made by this change. Blob website hosting incurs storage, operations and transfer charges; ACR, monitoring and compute can also incur charges. Verify subscription benefits and current prices before creation. The older weekend estimates were not a verified budget. The script's $20 monthly budget is an alert threshold, not a spending cap. Keep Front Door and Cosmos out of the initial deployment; scale the API to zero after judging.

Cost alert: `infra/20-cost-alert.sh`. If the budget API refuses the student offer, watch the remaining credit on the Azure Sponsorships portal (https://www.microsoftazuresponsorships.com/). The subscription is cancelled when the credit runs out.

**Open mismatch with `.env.example`:** it still lists `AZURE_STORAGE_CONNECTION_STRING`, `AZURE_STORAGE_CONTAINER` and
`CDN_BASE_URL`. This runbook uses managed identity (`STORAGE_ACCOUNT_URL`, `FRAMES_CONTAINER`, `STATE_CONTAINER`) and
`FRAMES_PUBLIC_BASE` instead. TODO(team): pick one set and update `.env.example`.
