#!/usr/bin/env bash
# 00-preflight.sh (issue #7): read-only Azure preflight. Safe to run any time.
# The one Azure change it makes is registering resource providers (idempotent, free).
# Every call is pinned to $AZ_SUBSCRIPTION_ID (infra/.env.local).
# Ends with a block to paste into issue #7 and docs/DECISIONS.md.
#
# Usage:  bash infra/00-preflight.sh
# Exit:   0 region recommended; 4 allowed regions could not be confirmed (choose LOC by hand).
set -euo pipefail
# shellcheck source=infra/env.sh
source "$(dirname "$0")/env.sh"
require_az

# Preferred regions: closest to IRSA (Pasadena).
PREFERRED="westus2 westus3"
# Fallback search order (US west first), then anything else alphabetically.
ORDER="westus2 westus3 westus centralus southcentralus westcentralus northcentralus eastus2 eastus canadacentral"

csv() { local v; v=$(sed '/^$/d' <<<"$1" | paste -sd, - | sed 's/,/, /g'); echo "${v:-(none)}"; }
pick_first() {
  local r
  for r in $ORDER; do
    if in_list "$r" "$1"; then echo "$r"; return 0; fi
  done
  sed '/^$/d' <<<"$1" | sed -n '1p'
}

# --- 1. Account ---------------------------------------------------------------------------
log "1/8 Account"
info "azure-cli $(azq version --query '"azure-cli"' -o tsv)"
az account show --subscription "$AZ_SUBSCRIPTION_ID" --query "{subscription:name, user:user.name, state:state}" -o table
# quotaId names the offer, e.g. AzureForStudents_2018-01-01 (REST: Subscriptions - Get).
SUB_URL="https://management.azure.com/subscriptions/${AZ_SUBSCRIPTION_ID}?api-version=2022-12-01"
QUOTA_ID=$(azq rest --method get --url "$SUB_URL" --query subscriptionPolicies.quotaId -o tsv) || QUOTA_ID="unknown"
SPEND_LIMIT=$(azq rest --method get --url "$SUB_URL" --query subscriptionPolicies.spendingLimit -o tsv) || SPEND_LIMIT="unknown"
info "offer quotaId: $QUOTA_ID   spendingLimit: $SPEND_LIMIT"
if [[ $QUOTA_ID == AzureForStudents* ]]; then
  info "Azure for Students: Cost Management may not support budgets for this offer; 20-cost-alert.sh tries and falls back."
fi

# --- 2. Providers (the one mutating step) -------------------------------------------------
log "2/8 Resource providers (registering is idempotent and free; the only change this script makes)"
for ns in "${REQUIRED_PROVIDERS[@]}"; do
  state=$(azsq provider show -n "$ns" --query registrationState -o tsv)
  if [[ $state == Registered ]]; then
    info "$ns: Registered"
  else
    azs provider register -n "$ns" --only-show-errors >/dev/null
    info "$ns: $state -> registration requested (10-core.sh waits for it)"
  fi
done

# --- 3. Policy: allowed locations ---------------------------------------------------------
log "3/8 Policy assignments at subscription scope (management-group ones included; see the scope column)"
azs policy assignment list --filter "$POLICY_FILTER" \
  --query "[].{displayName:displayName, name:name, scope:scope}" -o table || warn "could not list policy assignments"
read_allowed_regions
case $POLICY_STATE in
  ok)
    info "Location-type assignments:"
    azs policy assignment list --filter "$POLICY_FILTER" \
      --query "${LOCQ}.{displayName:displayName, scope:scope, enforcementMode:enforcementMode, parameters:parameters}" -o json
    info "Allowed regions: $(csv "$ALLOWED")"
    ;;
  none)
    warn "No allowed-locations policy is visible. Azure for Students normally has one named
      'Allowed resource deployment regions'; a hidden restriction (RequestDisallowedByAzure) may still apply."
    ;;
  *)
    warn "Location policies exist but their region list could not be read or parsed:"
    azs policy assignment list --filter "$POLICY_FILTER" \
      --query "${LOCQ}.{displayName:displayName, scope:scope, parameters:parameters}" -o json || true
    ;;
esac

# --- 4. Flex Consumption ------------------------------------------------------------------
log "4/8 Functions Flex Consumption regions (python)"
FLEX=$(azsq functionapp list-flexconsumption-locations --runtime python --query "[].name" -o tsv | norm_regions) || {
  warn "list-flexconsumption-locations failed (Microsoft.Web may still be registering; rerun in a minute)"
  FLEX=""
}
info "Flex (python): $(csv "$FLEX")"

# --- 5. Container Apps --------------------------------------------------------------------
log "5/8 Container Apps environment regions"
ACA=$(azsq provider show -n Microsoft.App \
  --query "resourceTypes[?resourceType=='managedEnvironments'].locations | [0]" -o tsv | norm_regions)
info "Container Apps: $(csv "$ACA")"

# --- 6. Static Web Apps -------------------------------------------------------------------
log "6/8 Static Web Apps regions"
SWA_REGIONS=$(azsq provider show -n Microsoft.Web \
  --query "resourceTypes[?resourceType=='staticSites'].locations | [0]" -o tsv | norm_regions)
info "SWA: $(csv "$SWA_REGIONS")"

# --- 7. Cosmos DB free tier ---------------------------------------------------------------
log "7/8 Cosmos DB free tier (one per subscription)"
if FT=$(azsq cosmosdb list --query "[?enableFreeTier].name" -o tsv 2>/dev/null); then
  if [[ -n $FT ]]; then COSMOS_FREE="already used by: $(csv "$FT")"; else COSMOS_FREE="available"; fi
else
  COSMOS_FREE="unknown (cosmosdb list failed; Microsoft.DocumentDB may still be registering)"
fi
info "$COSMOS_FREE"

# --- 8. Recommendation --------------------------------------------------------------------
log "8/8 Recommendation"
STAMP=$(date '+%Y-%m-%d %H:%M')
F_C=$(intersect "$FLEX" "$ACA")

if [[ $POLICY_STATE != ok ]]; then
  cat <<EOF

==================== paste into issue #7 and docs/DECISIONS.md ====================
## ${STAMP} - Azure region and subscription preflight
Decision: none yet. Could not confirm allowed regions (policy: ${POLICY_STATE}); LOC must be set by hand.
Why: offer quotaId=${QUOTA_ID}, spendingLimit=${SPEND_LIMIT}. Flex (python) + Container Apps: $(csv "$F_C").
SWA regions: $(csv "$SWA_REGIONS"). Cosmos free tier: ${COSMOS_FREE}.
Owner: TODO(team)
====================================================================================

Could not confirm allowed regions; set LOC manually after checking the portal
(Policy > Assignments > "Allowed resource deployment regions" > Parameters). Pick one that is
also in "Flex (python) + Container Apps" above, and an SWA_LOC from the SWA list that the policy allows:
  export LOC=<region> SWA_LOC=<region>
EOF
  exit 4
fi

A_F_C=$(intersect "$ALLOWED" "$F_C")
A_F_C_S=$(intersect "$A_F_C" "$SWA_REGIONS")
A_C=$(intersect "$ALLOWED" "$ACA")
A_S=$(intersect "$ALLOWED" "$SWA_REGIONS")

REC_LOC=""
WHY=""
for r in $PREFERRED; do
  if in_list "$r" "$A_F_C"; then
    REC_LOC=$r
    WHY="preferred (near IRSA), allowed, Flex, Container Apps"
    break
  fi
done
if [[ -z $REC_LOC && -n $A_F_C_S ]]; then
  REC_LOC=$(pick_first "$A_F_C_S")
  WHY="first region that is allowed + Flex + Container Apps + SWA"
fi
if [[ -z $REC_LOC && -n $A_F_C ]]; then
  REC_LOC=$(pick_first "$A_F_C")
  WHY="allowed + Flex + Container Apps; SWA must go in another region"
fi
if [[ -z $REC_LOC && -n $A_C ]]; then
  REC_LOC=$(pick_first "$A_C")
  WHY="allowed + Container Apps but NO Flex: run the watcher as a Container Apps Job (PLAN risk 11)"
fi

REC_SWA=""
if [[ -n $REC_LOC ]] && in_list "$REC_LOC" "$A_S"; then
  REC_SWA=$REC_LOC
elif [[ -n $A_S ]]; then
  REC_SWA=$(pick_first "$A_S")
fi

cat <<EOF

==================== paste into issue #7 and docs/DECISIONS.md ====================
## ${STAMP} - Azure region and subscription preflight
Decision: LOC=${REC_LOC:-NONE}, SWA_LOC=${REC_SWA:-NONE}. ${WHY:-No allowed region supports Container Apps.}
Why: offer quotaId=${QUOTA_ID}, spendingLimit=${SPEND_LIMIT}. Allowed regions (policy): $(csv "$ALLOWED").
Allowed + Flex (python): $(csv "$(intersect "$ALLOWED" "$FLEX")"). Allowed + Container Apps: $(csv "$A_C").
Allowed + SWA: $(csv "$A_S"). Cosmos free tier: ${COSMOS_FREE}.
Owner: TODO(team)
====================================================================================
EOF

if [[ -z $REC_LOC ]]; then
  die "No allowed region supports Container Apps. Check the policy output above and ask in team chat."
fi
if [[ -z $REC_SWA ]]; then
  warn "No allowed region supports Static Web Apps. Fallback: serve the built frontend from the storage
      account's static website (\$web container) or GitHub Pages, and record it in docs/DECISIONS.md."
fi

cat <<EOF

Next:
  export LOC=${REC_LOC} SWA_LOC=${REC_SWA:-<none>}
  bash infra/05-oidc-test.sh
  bash infra/10-core.sh
EOF
