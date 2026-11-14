# Azure resources

Every resource must name the problem it solves. Remove any resource without one.

| Resource | Problem it solves | Tier | Status |
|---|---|---|---|
| Static Web Apps (Free) | Global, zero-ops hosting for the UI. It also carries **golden snapshots of the 5 targets**, so judging works even when the API, IRSA or Blob is down. | MVP | not created |
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

None of these scripts has been run yet. They are re-runnable: each one checks before it creates, so a rerun only fills in what is missing. All names live in `infra/env.sh`.

**Prerequisites (once)**
- Azure CLI 2.92.0 or later: `winget install -e --id Microsoft.AzureCLI`, then open a **new** Git Bash so `az` is on PATH. Or use **Azure Cloud Shell** (Bash), which already has `az` and `gh`; clone the repo there.
- Call plain `az`. Calling `az.cmd` by its full path from Git Bash goes through cmd.exe, which breaks `--query` strings that contain `{}` or `|`.
- `az login`. The UIC tenant has two subscriptions. **"Azure for Students" is ours**; "UIC-ACCC-WVD" is university-managed, never touch it. Every script selects `AZ_SUBSCRIPTION` (default `Azure for Students`), prints it, and aborts if another subscription is active.
- `gh auth login` (as a repo admin) before step 3, so it can set the Actions secrets. Without it, the script prints the `gh secret set` commands instead.

**Order** (from the repo root):

| # | Command | What it changes | Paste back on issue #7 |
|---|---|---|---|
| 1 | `bash infra/00-preflight.sh` | Registers resource providers only (idempotent, free). Everything else is read-only. | The block between the `=====` lines. It also goes in `docs/DECISIONS.md`. |
| 2 | `export LOC=<rec> SWA_LOC=<rec>` | Nothing. Use the values step 1 recommends. | — |
| 3 | `bash infra/05-oidc-test.sh` | App registration `gh-planetx` with a federated credential for `main`, the resource group, Contributor on it, 3 GitHub secrets | "OIDC allowed", or "OIDC blocked → GHCR plan B" (exit code 2) |
| 4 | `bash infra/10-core.sh` | Resource group, Log Analytics, App Insights, storage (`frames` public read, `state` private, Blob CORS), ACR, Container Apps environment, Static Web App | The "core resources" block (names and URLs only) |
| 5 | `ALERT_EMAIL=you@example.com bash infra/20-cost-alert.sh` | $20/month budget on the resource group, email at 50/80/100 % of actual cost | "cost alert set", or which fallback you used (exit code 3) |

- Keep `SUF`, `LOC` and `SWA_LOC` the same on every run (export them once per shell). `SUF` is fixed in `env.sh`. Change it only if `10-core.sh` says a name is taken.
- Exit codes: 0 ok, 1 error, 2 OIDC blocked (use plan B), 3 budget API refused (use the portal fallback).
- Step 3 will probably fail on this university tenant: students usually can't register apps (403 `Authorization_RequestDenied`). That's fine. Plan B (below) needs no Azure secrets in GitHub.
- Step 5 will probably fail too: Cost Management lists Azure for Students (MS-AZR-0170P) as unsupported. The script then prints the portal fallback and the credit-balance link.
- The scripts never print keys or connection strings. The Container App, Function app and Cosmos DB are not created here (#23, #24, T3).

## Runbook for later issues (draft, not yet run)

Moved here from `docs/PLAN.md` §8. Steps 0–4, the environment in step 6 and the SWA in step 7 are now the scripts above. What follows is still a draft for #23 (Container App, deploys), #24 (Function) and T3 (Cosmos). Run it in Git Bash or Cloud Shell after `source infra/env.sh`.

**Corrections to the original draft** (checked on 2026-11-14 against Azure CLI 2.92.0 `-h` and learn.microsoft.com):
- `SUF=$RANDOM` created new resources on every run. Names now come from `infra/env.sh` with a fixed `SUF`.
- Git Bash rewrites arguments that start with `/` (`--scope /subscriptions/...`) into Windows paths. `env.sh` sets `MSYS_NO_PATHCONV=1`.
- `az policy assignment list` without a filter sends `atExactScope()`, so a region policy inherited from a management group stays hidden. Use `--filter "atScope()"`.
- `az functionapp list-flexconsumption-locations` takes `--runtime python`, which lists only regions with Python on Flex.
- `az storage container create --auth-mode key` → `az storage container-rm create` (goes through ARM, needs no account key).
- `az storage cors add` appends a rule on every run. Clear first (`az storage cors clear --services b`).
- `az containerapp env create`: the `--logs-destination` default changes from `log-analytics` to `azure-monitor` in CLI 2.93.0. Pass `--logs-destination log-analytics` with the workspace ID and key.
- `ENV=cae-planetx` is renamed `CAE`: `ENV` is a special shell variable.
- The SWA is created without `--source`/`--login-with-github`, so no workflow or token is generated; the deploy pipeline is #23. Its `-l` was hard-coded to `westus2`. It must be an SWA region (`westus2, centralus, eastus2, westeurope, eastasia`) that the region policy also allows.
- OIDC role assignment: `--assignee $APP_ID` → `--assignee-object-id <SP object id> --assignee-principal-type ServicePrincipal`, which avoids Graph lookups and propagation errors on a new SP.
- `Microsoft.Cdn` is dropped from the provider list. Register it only before step 10 (Front Door).
- `az extension add -n containerapp` is optional: `containerapp env create` is in the core CLI. `application-insights` is still an extension; `10-core.sh` installs it.
- Cost alert: Azure for Students is not supported by Cost Management, so a budget may be impossible. The credit balance is on https://www.microsoftazuresponsorships.com/.

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

**GitHub OIDC for CI.** `infra/05-oidc-test.sh` does this idempotently: app registration `gh-planetx`, federated credential with subject `repo:ompatel181005/IntoTheUnknown:ref:refs/heads/main` (issuer `https://token.actions.githubusercontent.com`, audience `api://AzureADTokenExchange`), Contributor on `rg-planetx`, then the GitHub secrets `AZURE_CLIENT_ID`, `AZURE_TENANT_ID` and `AZURE_SUBSCRIPTION_ID`. If the tenant blocks app registration, use **plan B**: CI pushes a public image to GHCR (`ghcr.io/ompatel181005/planetx-api:<sha>`, built-in `GITHUB_TOKEN` with `packages: write`), and a laptop or Cloud Shell runs `az containerapp update -g rg-planetx -n ca-planetx-api --image ghcr.io/ompatel181005/planetx-api:<sha>`. That needs no Azure secrets in GitHub and no local Docker.

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
For the web app: the SWA was created without GitHub wiring, so it generates no workflow. #23 adds one that deploys with the SWA deployment token and sets `env: { VITE_API_BASE: https://<api-fqdn>, VITE_FRAMES_BASE: https://<sa>.blob.core.windows.net/frames }` on the build.

**Environment variables:**
- **API:** `STORAGE_ACCOUNT_URL`, `FRAMES_CONTAINER`, `STATE_CONTAINER`, `FRAMES_PUBLIC_BASE`, `APPLICATIONINSIGHTS_CONNECTION_STRING`, `REFRESH_KEY`, `ALLOWED_ORIGINS`, `CUTOUT_MAX_WORKERS`, `IRSA_TIMEOUT_S`, `PIPELINE_VERSION`, `COSMOS_ENDPOINT`, `COSMOS_KEY`, `COSMOS_DB`
- **Watcher:** `API_BASE`, `REFRESH_KEY`, `STORAGE_ACCOUNT_URL`, plus `AzureWebJobsStorage` and App Insights, which Flex sets automatically.
- **Web** (build time): `VITE_API_BASE`, `VITE_FRAMES_BASE`

**Cost against the $100 credit.** Container Apps rates are from memory, so confirm them in the pricing calculator.

| Item | Weekend | Through Dec 31 |
|---|---|---|
| SWA Free, Functions Flex, Cosmos free tier, App Insights (< 5 GB) | $0 | $0 |
| Container Apps, 1 vCPU / 2 GiB, min-replicas = 1 only on judging days | ~$0–2 | ~$5–20 (about $20/month if left at min=1) |
| ACR Standard | $0 (free for 12 months) | $0 |
| Blob (< 5 GB) | < $0.10 | < $1 |
| Front Door Standard ($35/month, billed hourly) | ~$2–3 | **~$55 if left on**, so delete after local judging |
| **Total** | **< $10** | **~$10–30** (Front Door deleted) |

Cost alert: `infra/20-cost-alert.sh`. If the budget API refuses the student offer, watch the remaining credit on the Azure Sponsorships portal (https://www.microsoftazuresponsorships.com/). The subscription is cancelled when the credit runs out.

**Open mismatch with `.env.example`:** it still lists `AZURE_STORAGE_CONNECTION_STRING`, `AZURE_STORAGE_CONTAINER` and
`CDN_BASE_URL`. This runbook uses managed identity (`STORAGE_ACCOUNT_URL`, `FRAMES_CONTAINER`, `STATE_CONTAINER`) and
`FRAMES_PUBLIC_BASE` instead. TODO(team): pick one set and update `.env.example`.
