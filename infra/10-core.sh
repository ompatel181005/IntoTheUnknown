#!/usr/bin/env bash
# 10-core.sh (issue #7): create-if-missing for the core resources. Safe to rerun.
#   resource group, Log Analytics + workspace-based Application Insights, storage account
#   (frames public-read, state private, Blob CORS), ACR Standard, Container Apps environment,
#   Static Web App (Free, no GitHub wiring; the deploy pipeline is #23).
# Prints names and URLs only, never keys or connection strings.
#
# Usage:  LOC=<region> SWA_LOC=<region> bash infra/10-core.sh   (values from 00-preflight.sh)
set -euo pipefail
# shellcheck source=infra/env.sh
source "$(dirname "$0")/env.sh"
require_az

log "Settings: LOC=$LOC SWA_LOC=$SWA_LOC SUF=$SUF RG=$RG"

# --- Providers and CLI extension ----------------------------------------------------------
log "Resource providers"
for ns in "${REQUIRED_PROVIDERS[@]}"; do
  state=$(azq provider show -n "$ns" --query registrationState -o tsv)
  if [[ $state != Registered ]]; then
    info "$ns: $state, registering and waiting..."
    az provider register -n "$ns" --wait --only-show-errors >/dev/null
  fi
done
info "all registered"
# az monitor app-insights is an extension; install it up front so nothing prompts mid-script.
az extension add --name application-insights --upgrade --yes --only-show-errors

# --- Resource group -----------------------------------------------------------------------
log "Resource group $RG"
if exists az group show -n "$RG"; then
  RG_LOC=$(azq group show -n "$RG" --query location -o tsv)
  info "exists (location $RG_LOC)"
  [[ $RG_LOC == "$LOC" ]] || warn "RG is in $RG_LOC but LOC=$LOC. Resources still go to LOC; that is fine."
else
  az group create -n "$RG" -l "$LOC" -o none
  info "created"
fi

# --- Observability ------------------------------------------------------------------------
log "Log Analytics workspace $LAW"
if exists az monitor log-analytics workspace show -g "$RG" -n "$LAW"; then
  info "exists"
else
  az monitor log-analytics workspace create -g "$RG" -n "$LAW" -l "$LOC" -o none
  info "created"
fi
LAW_RID=$(azq monitor log-analytics workspace show -g "$RG" -n "$LAW" --query id -o tsv)

log "Application Insights $AI (workspace-based)"
if exists az monitor app-insights component show -g "$RG" --app "$AI"; then
  info "exists"
else
  az monitor app-insights component create -g "$RG" --app "$AI" -l "$LOC" \
    --workspace "$LAW_RID" --application-type web --kind web -o none
  info "created"
fi

# --- Storage ------------------------------------------------------------------------------
log "Storage account $SA"
if exists az storage account show -g "$RG" -n "$SA"; then
  info "exists"
else
  AVAIL=$(azq storage account check-name -n "$SA" --query nameAvailable -o tsv)
  [[ $AVAIL == true ]] ||
    die "Storage name $SA is taken or invalid. Pick another SUF (3-10 lowercase letters/digits),
       export it, and use it for every script from now on."
  az storage account create -g "$RG" -n "$SA" -l "$LOC" --sku Standard_LRS --kind StorageV2 \
    --min-tls-version TLS1_2 --https-only true --allow-blob-public-access true -o none
  info "created"
fi

# Containers through ARM (container-rm): no account keys needed.
ensure_container() { # name public-access(blob|off)
  if exists az storage container-rm show -g "$RG" --storage-account "$SA" -n "$1"; then
    az storage container-rm update -g "$RG" --storage-account "$SA" -n "$1" --public-access "$2" -o none
    info "container $1: exists, public access set to $2"
  else
    az storage container-rm create -g "$RG" --storage-account "$SA" -n "$1" --public-access "$2" -o none
    info "container $1: created ($2)"
  fi
}
ensure_container "$FRAMES_CONTAINER" blob
ensure_container "$STATE_CONTAINER" off

log "Blob CORS (GET/HEAD/OPTIONS from any origin)"
# 'cors add' appends, so clear first: reruns leave exactly one rule.
# The CLI looks up the account key itself; it is never printed.
az storage cors clear --account-name "$SA" --services b --only-show-errors
az storage cors add --account-name "$SA" --services b --methods GET HEAD OPTIONS \
  --origins '*' --allowed-headers '*' --exposed-headers '*' --max-age 3600 --only-show-errors
info "one rule set"

# --- Container registry -------------------------------------------------------------------
log "Container registry $ACR (Standard)"
if exists az acr show -g "$RG" -n "$ACR"; then
  info "exists"
else
  AVAIL=$(azq acr check-name -n "$ACR" --query nameAvailable -o tsv)
  [[ $AVAIL == true ]] ||
    die "Registry name $ACR is taken or invalid. Pick another SUF, export it, and rerun."
  az acr create -g "$RG" -n "$ACR" -l "$LOC" --sku Standard --admin-enabled false -o none
  info "created"
fi
ACR_LOGIN=$(azq acr show -g "$RG" -n "$ACR" --query loginServer -o tsv)

# --- Container Apps environment -----------------------------------------------------------
log "Container Apps environment $CAE"
if exists az containerapp env show -g "$RG" -n "$CAE"; then
  info "exists"
else
  LAW_CUSTOMER_ID=$(azq monitor log-analytics workspace show -g "$RG" -n "$LAW" --query customerId -o tsv)
  LAW_KEY=$(azq monitor log-analytics workspace get-shared-keys -g "$RG" -n "$LAW" --query primarySharedKey -o tsv)
  # --logs-destination is marked "breaking change" in the CLI docs, so pin it explicitly.
  az containerapp env create -g "$RG" -n "$CAE" -l "$LOC" \
    --logs-destination log-analytics --logs-workspace-id "$LAW_CUSTOMER_ID" --logs-workspace-key "$LAW_KEY" -o none
  unset LAW_KEY
  info "created"
fi
CAE_DOMAIN=$(azq containerapp env show -g "$RG" -n "$CAE" --query properties.defaultDomain -o tsv)

# --- Static Web App -----------------------------------------------------------------------
log "Static Web App $SWA (Free, no GitHub wiring; deploy pipeline is #23)"
if exists az staticwebapp show -g "$RG" -n "$SWA"; then
  info "exists"
else
  SWA_REGIONS=$(azq provider show -n Microsoft.Web \
    --query "resourceTypes[?resourceType=='staticSites'].locations | [0]" -o tsv | norm_regions)
  in_list "$SWA_LOC" "$SWA_REGIONS" ||
    die "SWA_LOC=$SWA_LOC is not a Static Web Apps region. Valid: $(paste -sd' ' - <<<"$SWA_REGIONS").
       Pick one that 00-preflight.sh lists as allowed and export SWA_LOC."
  az staticwebapp create -g "$RG" -n "$SWA" -l "$SWA_LOC" --sku Free -o none
  info "created"
fi
SWA_HOST=$(azq staticwebapp show -g "$RG" -n "$SWA" --query defaultHostname -o tsv)

# --- Not created here ---------------------------------------------------------------------
# TODO(#23): Container App $API in $CAE (image from $ACR, or GHCR plan B), system identity with
#            AcrPull on $ACR and "Storage Blob Data Contributor" on $SA, secrets via
#            `az containerapp secret set`, ALLOWED_ORIGINS=https://$SWA_HOST.
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
  az monitor app-insights component show -g $RG --app $AI --query connectionString -o tsv
Next: ALERT_EMAIL=<you@example.com> bash infra/20-cost-alert.sh
EOF
