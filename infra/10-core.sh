#!/usr/bin/env bash
# 10-core.sh (issue #7): create-if-missing for the core resources. Safe to rerun.
#   resource group, Log Analytics + workspace-based Application Insights, storage account
#   (frames public-read, state private, Blob CORS), ACR Standard, Container Apps environment,
#   Static Web App (Free, no GitHub wiring; the deploy pipeline is #23).
# On rerun it verifies what exists (location, SKU, workspace link) and aborts on a mismatch.
# Every call is pinned to $AZ_SUBSCRIPTION_ID. Prints names and URLs only, never keys.
#
# Usage:  LOC=<region> SWA_LOC=<region> bash infra/10-core.sh   (both must be set explicitly)
set -euo pipefail
# shellcheck source=infra/env.sh
source "$(dirname "$0")/env.sh"

[[ -n ${LOC:-} ]] || die "LOC is not set. Export it explicitly: the region 00-preflight.sh recommends, or one you
       chose after checking Policy > Assignments in the portal. This script never guesses a region."
[[ -n ${SWA_LOC:-} ]] || die "SWA_LOC is not set. Export it explicitly (a Static Web Apps region the policy allows)."
require_az

log "Settings: LOC=$LOC SWA_LOC=$SWA_LOC SUF=$SUF RG=$RG"

# Abort when an existing resource differs from what this script would create.
expect() { # what actual wanted
  [[ ${2,,} == "${3,,}" ]] ||
    die "$1 is \"$2\" but this script expects \"$3\". Stopping here without touching it; fix it by hand, or change the names/env, then rerun."
}
loc_norm() { norm_regions <<<"$1"; }

# --- Region policy re-check ---------------------------------------------------------------
log "Region policy"
read_allowed_regions
if [[ $POLICY_STATE == ok ]]; then
  in_list "$LOC" "$ALLOWED" || die "LOC=$LOC is not allowed by policy. Allowed: $(paste -sd' ' - <<<"$ALLOWED")"
  in_list "$SWA_LOC" "$ALLOWED" || die "SWA_LOC=$SWA_LOC is not allowed by policy. Allowed: $(paste -sd' ' - <<<"$ALLOWED")"
  info "LOC and SWA_LOC are allowed"
else
  warn "Could not confirm allowed regions (policy: $POLICY_STATE). Using LOC=$LOC and SWA_LOC=$SWA_LOC as you set them."
fi

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
  LAW_KEY=$(azsq monitor log-analytics workspace get-shared-keys -g "$RG" -n "$LAW" --query primarySharedKey -o tsv)
  # The --logs-destination default changes to azure-monitor in CLI 2.93.0, so pin it.
  azs containerapp env create -g "$RG" -n "$CAE" -l "$LOC" \
    --logs-destination log-analytics --logs-workspace-id "$LAW_CUSTOMER_ID" --logs-workspace-key "$LAW_KEY" -o none
  unset LAW_KEY
  info "created"
fi
CAE_DOMAIN=$(azsq containerapp env show -g "$RG" -n "$CAE" --query properties.defaultDomain -o tsv)

# --- Static Web App -----------------------------------------------------------------------
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
    die "SWA_LOC=$SWA_LOC is not a Static Web Apps region. Valid: $(paste -sd' ' - <<<"$SWA_REGIONS")."
  azs staticwebapp create -g "$RG" -n "$SWA" -l "$SWA_LOC" --sku Free -o none
  info "created"
fi
SWA_HOST=$(azsq staticwebapp show -g "$RG" -n "$SWA" --query defaultHostname -o tsv)

# --- Not created here ---------------------------------------------------------------------
# TODO(#23): Container App $API in $CAE (image from $ACR, or GHCR plan B), system identity with
#            AcrPull on $ACR and "Storage Blob Data Contributor" on $SA, secrets via
#            `az containerapp secret set`, ALLOWED_ORIGINS=https://$SWA_HOST. Then grant the OIDC
#            app a role scoped to $API only (see 05-oidc-test.sh).
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
Static Web App          https://$SWA_HOST ($SWA_LOC)
=====================================================================================
Secrets are not printed. To read them later (do not paste them anywhere public):
  source infra/env.sh
  az monitor app-insights component show -g $RG --app $AI --query connectionString -o tsv --subscription "\$AZ_SUBSCRIPTION_ID"
Next: bash infra/05-oidc-test.sh (grants AcrPush now that $ACR exists), then
      ALERT_EMAIL=<you@example.com> bash infra/20-cost-alert.sh
EOF
