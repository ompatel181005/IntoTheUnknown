#!/usr/bin/env bash
# 10-core.sh (issue #7): create-if-missing for the core resources. Safe to rerun.
#   resource group, Log Analytics + workspace-based Application Insights, storage account
#   (frames public-read, state private, Blob CORS), ACR Standard, Container Apps environment,
#   and the frontend host: the storage account's static website (default, SWA_LOC=none), or a
#   Static Web App Free (no GitHub wiring) when SWA_LOC is an allowed SWA region. Deploys are #23.
# On rerun it verifies what exists (location, SKU, workspace link, ...) and aborts on a mismatch.
# Every call is pinned to $AZ_SUBSCRIPTION_ID. Prints names and URLs only, never keys.
#
# Usage:  LOC=<region> bash infra/10-core.sh          (LOC must be set explicitly)
#         ALLOW_UNVERIFIED_REGION=1 ...                (only if the region policy can't be read)
set -euo pipefail
# shellcheck source=infra/env.sh
source "$(dirname "$0")/env.sh"

[[ -n ${LOC:-} ]] || die "LOC is not set. Export it explicitly: the region 00-preflight.sh recommends, or one you
       chose after checking Policy > Assignments in the portal. This script never guesses a region."
require_az

log "Settings: LOC=$LOC SWA_LOC=$SWA_LOC SUF=$SUF RG=$RG"

# Abort when an existing resource differs from what this script would create.
expect() { # what actual wanted
  [[ ${2,,} == "${3,,}" ]] ||
    die "$1 is \"$2\" but this script expects \"$3\". Stopping here without touching it; fix it by hand, or change the names/env, then rerun."
}
loc_norm() { norm_regions <<<"$1"; }

# --- Region policy gate -------------------------------------------------------------------
# Refuses to go on unless the allowed-locations policy confirms LOC and SWA_LOC, or the human
# explicitly accepts the risk with ALLOW_UNVERIFIED_REGION=1.
check_region() { # scope-label [resource-group]
  read_allowed_regions "${2:-}"
  if [[ $POLICY_STATE == ok ]]; then
    in_list "$LOC" "$ALLOWED" ||
      die "LOC=$LOC is not allowed by policy at $1 scope. Allowed: $(paste -sd' ' - <<<"$ALLOWED")"
    if [[ $SWA_LOC != none ]]; then
      in_list "$SWA_LOC" "$ALLOWED" ||
        die "SWA_LOC=$SWA_LOC is not allowed by policy at $1 scope. Allowed: $(paste -sd' ' - <<<"$ALLOWED")"
    fi
    info "allowed at $1 scope: LOC=$LOC, SWA_LOC=$SWA_LOC"
  elif [[ ${ALLOW_UNVERIFIED_REGION:-} == 1 ]]; then
    warn "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
    warn "!! Allowed regions NOT confirmed at $1 scope (policy: $POLICY_STATE)."
    warn "!! ALLOW_UNVERIFIED_REGION=1, so continuing with LOC=$LOC SWA_LOC=$SWA_LOC on your word."
    warn "!! A wrong region fails later with RequestDisallowedByPolicy / RequestDisallowedByAzure."
    warn "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
  else
    die "Could not confirm allowed regions at $1 scope (policy: $POLICY_STATE). Check the portal
       (Policy > Assignments > Parameters). If LOC=$LOC and SWA_LOC=$SWA_LOC are right, rerun with
       ALLOW_UNVERIFIED_REGION=1 to proceed anyway."
  fi
}
log "Region policy (subscription scope)"
check_region subscription

# --- Providers and CLI extension ----------------------------------------------------------
log "Resource providers"
for ns in "${REQUIRED_PROVIDERS[@]}"; do
  state=$(azsq provider show -n "$ns" --query registrationState -o tsv)
  if [[ $state != Registered ]]; then
    info "$ns: $state, registering and waiting..."
    azs provider register -n "$ns" --wait --only-show-errors >/dev/null
  fi
done
info "all registered"
# az monitor app-insights is an extension; install it up front so nothing prompts mid-script.
az extension add --name application-insights --upgrade --yes --only-show-errors

# --- Resource group -----------------------------------------------------------------------
log "Resource group $RG"
if exists azs group show -n "$RG"; then
  expect "Resource group $RG location" "$(loc_norm "$(azsq group show -n "$RG" --query location -o tsv)")" "$LOC"
  info "exists, verified"
else
  azs group create -n "$RG" -l "$LOC" -o none
  info "created"
fi
# Policies assigned at the RG itself only become visible once the RG exists: check again.
log "Region policy (resource group scope)"
check_region "resource group $RG" "$RG"

# --- Observability ------------------------------------------------------------------------
log "Log Analytics workspace $LAW"
if exists azs monitor log-analytics workspace show -g "$RG" -n "$LAW"; then
  expect "Workspace $LAW location" \
    "$(loc_norm "$(azsq monitor log-analytics workspace show -g "$RG" -n "$LAW" --query location -o tsv)")" "$LOC"
  info "exists, verified"
else
  azs monitor log-analytics workspace create -g "$RG" -n "$LAW" -l "$LOC" -o none
  info "created"
fi
LAW_RID=$(azsq monitor log-analytics workspace show -g "$RG" -n "$LAW" --query id -o tsv)
LAW_CUSTOMER_ID=$(azsq monitor log-analytics workspace show -g "$RG" -n "$LAW" --query customerId -o tsv)

log "Application Insights $AI (workspace-based)"
if exists azs monitor app-insights component show -g "$RG" --app "$AI"; then
  expect "App Insights $AI location" \
    "$(loc_norm "$(azsq monitor app-insights component show -g "$RG" --app "$AI" --query location -o tsv)")" "$LOC"
  expect "App Insights $AI workspace" \
    "$(azsq monitor app-insights component show -g "$RG" --app "$AI" --query "workspaceResourceId || WorkspaceResourceId" -o tsv)" \
    "$LAW_RID"
  info "exists, verified (linked to $LAW)"
else
  azs monitor app-insights component create -g "$RG" --app "$AI" -l "$LOC" \
    --workspace "$LAW_RID" --application-type web --kind web -o none
  info "created"
fi

# --- Storage ------------------------------------------------------------------------------
log "Storage account $SA"
if exists azs storage account show -g "$RG" -n "$SA"; then
  expect "Storage $SA location" "$(loc_norm "$(azsq storage account show -g "$RG" -n "$SA" --query location -o tsv)")" "$LOC"
  expect "Storage $SA kind" "$(azsq storage account show -g "$RG" -n "$SA" --query kind -o tsv)" "StorageV2"
  expect "Storage $SA SKU" "$(azsq storage account show -g "$RG" -n "$SA" --query sku.name -o tsv)" "Standard_LRS"
  expect "Storage $SA minimum TLS version" \
    "$(azsq storage account show -g "$RG" -n "$SA" --query minimumTlsVersion -o tsv)" "TLS1_2"
  expect "Storage $SA HTTPS-only" \
    "$(azsq storage account show -g "$RG" -n "$SA" --query "enableHttpsTrafficOnly || supportsHttpsTrafficOnly" -o tsv)" "true"
  expect "Storage $SA allowBlobPublicAccess" \
    "$(azsq storage account show -g "$RG" -n "$SA" --query allowBlobPublicAccess -o tsv)" "true"
  info "exists, verified"
else
  AVAIL=$(azsq storage account check-name -n "$SA" --query nameAvailable -o tsv)
  [[ $AVAIL == true ]] ||
    die "Storage name $SA is taken or invalid. Pick another SUF (3-10 lowercase letters/digits),
       export it, and use it for every script from now on."
  azs storage account create -g "$RG" -n "$SA" -l "$LOC" --sku Standard_LRS --kind StorageV2 \
    --min-tls-version TLS1_2 --https-only true --allow-blob-public-access true -o none
  info "created"
fi

# Containers through ARM (container-rm): no account keys needed. Public access is enforced.
ensure_container() { # name public-access(blob|off)
  if exists azs storage container-rm show -g "$RG" --storage-account "$SA" -n "$1"; then
    azs storage container-rm update -g "$RG" --storage-account "$SA" -n "$1" --public-access "$2" -o none
    info "container $1: exists, public access set to $2"
  else
    azs storage container-rm create -g "$RG" --storage-account "$SA" -n "$1" --public-access "$2" -o none
    info "container $1: created ($2)"
  fi
}
ensure_container "$FRAMES_CONTAINER" blob
ensure_container "$STATE_CONTAINER" off

log "Blob CORS (GET/HEAD/OPTIONS from any origin, max age 3600)"
# Through ARM (blob-service-properties): no account key. Other rules are left alone; ours is
# added only if an identical rule is not already there.
CORS_MATCH="length(cors.corsRules[?length(allowedOrigins)==\`1\` && contains(allowedOrigins, '*') && length(allowedMethods)==\`3\` && contains(allowedMethods, 'GET') && contains(allowedMethods, 'HEAD') && contains(allowedMethods, 'OPTIONS') && contains(allowedHeaders, '*') && contains(exposedHeaders, '*') && maxAgeInSeconds==\`3600\`] || \`[]\`)"
HAVE=$(azsq storage account blob-service-properties show -g "$RG" -n "$SA" --query "$CORS_MATCH" -o tsv)
if [[ $HAVE -gt 0 ]]; then
  info "rule already present"
else
  azs storage account blob-service-properties cors-rule add -g "$RG" -n "$SA" \
    --allowed-origins '*' --allowed-methods GET HEAD OPTIONS --allowed-headers '*' --exposed-headers '*' \
    --max-age 3600 -o none
  info "rule added"
fi

# --- Container registry -------------------------------------------------------------------
log "Container registry $ACR (Standard)"
if exists azs acr show -g "$RG" -n "$ACR"; then
  expect "Registry $ACR location" "$(loc_norm "$(azsq acr show -g "$RG" -n "$ACR" --query location -o tsv)")" "$LOC"
  expect "Registry $ACR SKU" "$(azsq acr show -g "$RG" -n "$ACR" --query sku.name -o tsv)" "Standard"
  info "exists, verified"
else
  AVAIL=$(azsq acr check-name -n "$ACR" --query nameAvailable -o tsv)
  [[ $AVAIL == true ]] ||
    die "Registry name $ACR is taken or invalid. Pick another SUF, export it, and rerun."
  azs acr create -g "$RG" -n "$ACR" -l "$LOC" --sku Standard --admin-enabled false -o none
  info "created"
fi
ACR_LOGIN=$(azsq acr show -g "$RG" -n "$ACR" --query loginServer -o tsv)

# --- Container Apps environment -----------------------------------------------------------
log "Container Apps environment $CAE"
if exists azs containerapp env show -g "$RG" -n "$CAE"; then
  expect "Environment $CAE location" \
    "$(loc_norm "$(azsq containerapp env show -g "$RG" -n "$CAE" --query location -o tsv)")" "$LOC"
  expect "Environment $CAE logs destination" \
    "$(azsq containerapp env show -g "$RG" -n "$CAE" --query properties.appLogsConfiguration.destination -o tsv)" \
    "log-analytics"
  expect "Environment $CAE Log Analytics workspace" \
    "$(azsq containerapp env show -g "$RG" -n "$CAE" --query properties.appLogsConfiguration.logAnalyticsConfiguration.customerId -o tsv)" \
    "$LAW_CUSTOMER_ID"
  info "exists, verified (logs to $LAW)"
else
  # ARM resolves listKeys inside Azure. The CLI receives resource names only, never the key.
  # --logs-workspace-key is a plain string in CLI 2.92; @- is not a stdin reader for it.
  azs deployment group create -g "$RG" --name core-environment \
    --template-file "$INFRA_DIR/containerapp-environment.json" \
    --parameters "environmentName=$CAE" "location=$LOC" "workspaceResourceId=$LAW_RID" -o none
  info "created"
fi
CAE_DOMAIN=$(azsq containerapp env show -g "$RG" -n "$CAE" --query properties.defaultDomain -o tsv)

# --- Frontend host ------------------------------------------------------------------------
if [[ $SWA_LOC == none ]]; then
  # Default: the region policy allows no Static Web Apps region, so the built frontend is served
  # from this storage account's static website ($web container). Data-plane call, but
  # --auth-mode login needs only the management action blobServices/write (Owner has it): no key.
  log "Static website on $SA (replaces the Static Web App: no allowed SWA region)"
  azs storage blob service-properties update --account-name "$SA" --auth-mode login \
    --static-website true --index-document "$WEB_INDEX" --404-document "$WEB_INDEX" -o none
  expect "Static website on $SA" \
    "$(azsq storage blob service-properties show --account-name "$SA" --auth-mode login --query staticWebsite.enabled -o tsv)" \
    "true"
  expect "Static website index document" \
    "$(azsq storage blob service-properties show --account-name "$SA" --auth-mode login --query staticWebsite.indexDocument -o tsv)" \
    "$WEB_INDEX"
  expect "Static website error document" \
    "$(azsq storage blob service-properties show --account-name "$SA" --auth-mode login --query staticWebsite.errorDocument404Path -o tsv)" \
    "$WEB_INDEX"
  WEB_URL=$(azsq storage account show -g "$RG" -n "$SA" --query primaryEndpoints.web -o tsv)
  WEB_URL=${WEB_URL%/}
  [[ -n $WEB_URL ]] || die "Static website is on, but the account reports no web endpoint."
  info "enabled, verified: $WEB_URL"
  FRONTEND_LINE="Frontend (static web)  $WEB_URL  (deploy: upload to the \$web container)"
else
  log "Static Web App $SWA (Free, no GitHub wiring; deploy pipeline is #23)"
  if exists azs staticwebapp show -g "$RG" -n "$SWA"; then
    expect "Static Web App $SWA location" \
      "$(loc_norm "$(azsq staticwebapp show -g "$RG" -n "$SWA" --query location -o tsv)")" "$SWA_LOC"
    expect "Static Web App $SWA SKU" "$(azsq staticwebapp show -g "$RG" -n "$SWA" --query sku.name -o tsv)" "Free"
    info "exists, verified"
  else
    SWA_REGIONS=$(azsq provider show -n Microsoft.Web \
      --query "resourceTypes[?resourceType=='staticSites'].locations | [0]" -o tsv | norm_regions)
    in_list "$SWA_LOC" "$SWA_REGIONS" ||
      die "SWA_LOC=$SWA_LOC is not a Static Web Apps region. Valid: $(paste -sd' ' - <<<"$SWA_REGIONS"), or none."
    azs staticwebapp create -g "$RG" -n "$SWA" -l "$SWA_LOC" --sku Free -o none
    info "created"
  fi
  WEB_URL="https://$(azsq staticwebapp show -g "$RG" -n "$SWA" --query defaultHostname -o tsv)"
  FRONTEND_LINE="Static Web App          $WEB_URL ($SWA_LOC)"
fi

# --- Not created here ---------------------------------------------------------------------
# TODO(#23): Container App $API in $CAE (image from $ACR, or GHCR plan B), system identity with
#            AcrPull on $ACR and "Storage Blob Data Contributor" on $SA, secrets via
#            `az containerapp secret set`, ALLOWED_ORIGINS=<frontend URL printed below>. Then grant
#            the OIDC app a role scoped to $API only (see 05-oidc-test.sh).
# TODO(#23): with the static website, the frontend deploy is an upload to $web, e.g.
#            `az storage blob upload-batch -d '$web' -s frontend/dist --account-name $SA --auth-mode login`
#            (needs a blob data role); the frames CORS rule above already allows any origin.
# TODO(#24): Function app $FUNC (Flex Consumption, python 3.11, --storage-account $SA, --app-insights $AI).
# TODO(T3):  Cosmos DB $COSMOS with --enable-free-tier true (one per subscription).

# --- Summary (names and URLs only) --------------------------------------------------------
cat <<EOF

==================== core resources (safe to post on issue #7) ====================
Resource group          $RG ($LOC)
Log Analytics           $LAW
Application Insights    $AI
Storage account         $SA
  frames (public read)  https://$SA.blob.core.windows.net/$FRAMES_CONTAINER
  state (private)       https://$SA.blob.core.windows.net/$STATE_CONTAINER
Container registry      $ACR_LOGIN
Container Apps env      $CAE (default domain $CAE_DOMAIN)
$FRONTEND_LINE
=====================================================================================
Secrets are not printed. To read them later (do not paste them anywhere public):
  source infra/env.sh
  az monitor app-insights component show -g $RG --app $AI --query connectionString -o tsv --subscription "\$AZ_SUBSCRIPTION_ID"
Next: bash infra/05-oidc-test.sh (grants AcrPush now that $ACR exists), then
      ALERT_EMAIL=<you@example.com> bash infra/20-cost-alert.sh
EOF
