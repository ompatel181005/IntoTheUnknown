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

## Runbook (draft, not yet run)

Moved here from `docs/PLAN.md` §8. Nothing below has been executed. It is also not re-runnable as written
(`SUF=$RANDOM` changes on every run): fix `SUF` once and export it before turning this into scripts.

Commands are Bash. They run in Git Bash or in **Azure Cloud Shell**, which has az preinstalled and is quickest. Verify flags with `-h` as you go.

```bash
# 0. Tools (Windows) — or skip and use Cloud Shell
winget install -e --id Microsoft.AzureCLI
npm i -g azure-functions-core-tools@4 @azure/static-web-apps-cli
az login
az extension add -n containerapp --upgrade
az extension add -n application-insights --upgrade
for ns in Microsoft.App Microsoft.OperationalInsights Microsoft.Insights Microsoft.Web Microsoft.Storage \
          Microsoft.ContainerRegistry Microsoft.DocumentDB Microsoft.Cdn; do az provider register -n $ns; done

# 1. Region preflight — Azure for Students may carry an "allowed locations" policy
az policy assignment list --query "[].{name:displayName, params:parameters}" -o json
az functionapp list-flexconsumption-locations -o table
# Pick LOC: prefer westus2/westus3 (nearest IRSA in Pasadena) if allowed and Flex-capable.
# SWA Free must also be in an SWA region (e.g. westus2/centralus/eastus2) that the policy allows.

LOC=westus2; RG=rg-planetx; SUF=$RANDOM
SA=stplanetx$SUF; ACR=acrplanetx$SUF; LAW=log-planetx; AI=appi-planetx
ENV=cae-planetx; API=ca-planetx-api; FUNC=func-planetx-$SUF; COSMOS=cosmos-planetx-$SUF; SWA=swa-planetx
az group create -n $RG -l $LOC

# 2. Observability first (everything reports into it)
az monitor log-analytics workspace create -g $RG -n $LAW -l $LOC
LAW_ID=$(az monitor log-analytics workspace show -g $RG -n $LAW --query customerId -o tsv)
LAW_KEY=$(az monitor log-analytics workspace get-shared-keys -g $RG -n $LAW --query primarySharedKey -o tsv)
az monitor app-insights component create -g $RG -a $AI -l $LOC --workspace $LAW
AI_CONN=$(az monitor app-insights component show -g $RG -a $AI --query connectionString -o tsv)

# 3. Storage: frames (public read) + state (private)
az storage account create -g $RG -n $SA -l $LOC --sku Standard_LRS --kind StorageV2 \
  --min-tls-version TLS1_2 --allow-blob-public-access true
az storage container create --account-name $SA -n frames --public-access blob --auth-mode key
az storage container create --account-name $SA -n state  --public-access off  --auth-mode key
az storage cors add --account-name $SA --services b --methods GET HEAD OPTIONS \
  --origins '*' --allowed-headers '*' --exposed-headers '*' --max-age 3600
SA_ID=$(az storage account show -g $RG -n $SA --query id -o tsv)

# 4. Registry (student offer: 1 Standard registry free for 12 months)
az acr create -g $RG -n $ACR --sku Standard
ACR_ID=$(az acr show -n $ACR --query id -o tsv)

# 5. Cosmos DB — start early (5–10 min). Free tier must be chosen at creation; one per subscription.
az cosmosdb create -g $RG -n $COSMOS --enable-free-tier true \
  --locations regionName=$LOC failoverPriority=0 isZoneRedundant=False --no-wait

# 6. Container Apps env + API (after CI has pushed the first image; app listens on 8000)
az containerapp env create -g $RG -n $ENV -l $LOC --logs-workspace-id $LAW_ID --logs-workspace-key $LAW_KEY
az containerapp create -g $RG -n $API --environment $ENV \
  --image $ACR.azurecr.io/planetx-api:bootstrap --registry-server $ACR.azurecr.io --registry-identity system \
  --target-port 8000 --ingress external --cpu 1.0 --memory 2.0Gi --min-replicas 0 --max-replicas 1 --system-assigned
#   (if the --registry-identity create fails: create with a public placeholder image, assign AcrPull, then
#    `az containerapp registry set -g $RG -n $API --server $ACR.azurecr.io --identity system`)
PRINCIPAL=$(az containerapp show -g $RG -n $API --query identity.principalId -o tsv)
az role assignment create --assignee $PRINCIPAL --role "Storage Blob Data Contributor" --scope $SA_ID
az role assignment create --assignee $PRINCIPAL --role AcrPull --scope $ACR_ID
REFRESH_KEY=$(openssl rand -hex 24)
az containerapp secret set -g $RG -n $API --secrets appi-conn="$AI_CONN" refresh-key="$REFRESH_KEY"
API_URL=https://$(az containerapp show -g $RG -n $API --query properties.configuration.ingress.fqdn -o tsv)

# 7. Static Web App (Free) wired to GitHub — creates the deploy workflow + token secret
az staticwebapp create -g $RG -n $SWA -l westus2 --sku Free \
  --source https://github.com/<org>/<repo> --branch main \
  --app-location frontend --output-location dist --login-with-github
SWA_HOST=$(az staticwebapp show -g $RG -n $SWA --query defaultHostname -o tsv)
az containerapp update -g $RG -n $API --set-env-vars \
  STORAGE_ACCOUNT_URL=https://$SA.blob.core.windows.net FRAMES_CONTAINER=frames STATE_CONTAINER=state \
  FRAMES_PUBLIC_BASE=https://$SA.blob.core.windows.net/frames \
  APPLICATIONINSIGHTS_CONNECTION_STRING=secretref:appi-conn REFRESH_KEY=secretref:refresh-key \
  ALLOWED_ORIGINS=https://$SWA_HOST,http://localhost:5173 CUTOUT_MAX_WORKERS=10 IRSA_TIMEOUT_S=120 PIPELINE_VERSION=1

# 8. Watcher Function (Flex Consumption, Python 3.11)
az functionapp create -g $RG -n $FUNC --storage-account $SA --flexconsumption-location $LOC \
  --runtime python --runtime-version 3.11 --app-insights $AI
az functionapp identity assign -g $RG -n $FUNC
FPRIN=$(az functionapp identity show -g $RG -n $FUNC --query principalId -o tsv)
az role assignment create --assignee $FPRIN --role "Storage Blob Data Contributor" --scope $SA_ID
az functionapp config appsettings set -g $RG -n $FUNC --settings \
  API_BASE=$API_URL REFRESH_KEY=$REFRESH_KEY STORAGE_ACCOUNT_URL=https://$SA.blob.core.windows.net
(cd functions && func azure functionapp publish $FUNC)
#   Fallback if Flex is unavailable in LOC: same code as a Container Apps Job
#   az containerapp job create -g $RG -n job-watcher --environment $ENV --trigger-type Schedule \
#     --cron-expression "0 6 * * *" --image $ACR.azurecr.io/planetx-api:<sha> --command python -m app.watch ...

# 9. Cosmos containers (when step 5 finishes)
az cosmosdb sql database create -g $RG -a $COSMOS -n planetx --throughput 400
az cosmosdb sql container create -g $RG -a $COSMOS -d planetx -n candidates --partition-key-path /hpx5
COSMOS_KEY=$(az cosmosdb keys list -g $RG -n $COSMOS --query primaryMasterKey -o tsv)
az containerapp secret set -g $RG -n $API --secrets cosmos-key="$COSMOS_KEY"
az containerapp update -g $RG -n $API --set-env-vars \
  COSMOS_ENDPOINT=https://$COSMOS.documents.azure.com:443/ COSMOS_KEY=secretref:cosmos-key COSMOS_DB=planetx

# 10. (Optional, Sunday) Front Door Standard in front of the frames container — delete after local judging
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

**GitHub OIDC for CI** (do this at H0–1). If the student tenant blocks app registration, use **plan B**: CI pushes a public image to GHCR, and a laptop or Cloud Shell runs `az containerapp update --image ghcr.io/<org>/planetx-api:<sha>`. That needs no Azure secrets in GitHub and no local Docker.
```bash
APP_ID=$(az ad app create --display-name gh-planetx --query appId -o tsv); az ad sp create --id $APP_ID
az ad app federated-credential create --id $APP_ID --parameters '{"name":"gh-main","issuer":"https://token.actions.githubusercontent.com","subject":"repo:<org>/<repo>:ref:refs/heads/main","audiences":["api://AzureADTokenExchange"]}'
az role assignment create --assignee $APP_ID --role Contributor --scope $(az group show -n $RG --query id -o tsv)
gh secret set AZURE_CLIENT_ID -b $APP_ID
gh secret set AZURE_TENANT_ID -b $(az account show --query tenantId -o tsv)
gh secret set AZURE_SUBSCRIPTION_ID -b $(az account show --query id -o tsv)
```
`.github/workflows/api.yml` (a hotspot: the infra owner adds it, ask the human first):
```yaml
name: api
on: { push: { branches: [main], paths: ["backend/**"] }, workflow_dispatch: {} }
permissions: { id-token: write, contents: read }
jobs:
  deploy:
    runs-on: ubuntu-latest
    env: { ACR: acrplanetxNNNN, RG: rg-planetx, APP: ca-planetx-api }
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
For the web app, SWA generates its own workflow. Add `env: { VITE_API_BASE: https://<api-fqdn>, VITE_FRAMES_BASE: https://<sa>.blob.core.windows.net/frames }` to its deploy step.

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

Set a cost alert in Cost Management, or watch the Sponsorships portal.

**Open mismatch with `.env.example`:** it still lists `AZURE_STORAGE_CONNECTION_STRING`, `AZURE_STORAGE_CONTAINER` and
`CDN_BASE_URL`. This runbook uses managed identity (`STORAGE_ACCOUNT_URL`, `FRAMES_CONTAINER`, `STATE_CONTAINER`) and
`FRAMES_PUBLIC_BASE` instead. TODO(team): pick one set and update `.env.example`.
