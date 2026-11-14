#!/usr/bin/env bash
# 00-preflight.sh (issue #7): read-only Azure preflight. Safe to run any time.
# The one Azure change it makes is registering resource providers (idempotent, free). Locally it
# selects $AZ_SUBSCRIPTION as the CLI default, like every script here.
# Ends with a block to paste into issue #7 and docs/DECISIONS.md.
#
# Usage:  bash infra/00-preflight.sh
set -euo pipefail
# shellcheck source=infra/env.sh
source "$(dirname "$0")/env.sh"
require_az

# Preferred regions: closest to IRSA (Pasadena).
PREFERRED="westus2 westus3"
# Fallback search order (US west first), then anything else alphabetically.
ORDER="westus2 westus3 westus centralus southcentralus westcentralus northcentralus eastus2 eastus canadacentral"
# Built-in "Allowed locations" policy definition.
ALLOWED_LOC_DEF="e56962a6-4747-49cd-b67b-bf8b01975c4c"

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
az account show --query "{subscription:name, id:id, tenant:tenantId, user:user.name, state:state}" -o table
SUB_ID=$(azq account show --query id -o tsv)
# quotaId names the offer, e.g. AzureForStudents_2018-01-01 (REST: Subscriptions - Get).
SUB_URL="https://management.azure.com/subscriptions/${SUB_ID}?api-version=2022-12-01"
QUOTA_ID=$(azq rest --method get --url "$SUB_URL" --query subscriptionPolicies.quotaId -o tsv) || QUOTA_ID="unknown"
SPEND_LIMIT=$(azq rest --method get --url "$SUB_URL" --query subscriptionPolicies.spendingLimit -o tsv) || SPEND_LIMIT="unknown"
info "offer quotaId: $QUOTA_ID   spendingLimit: $SPEND_LIMIT"
if [[ $QUOTA_ID == AzureForStudents* ]]; then
  info "Azure for Students: Cost Management lists this offer as unsupported, so 20-cost-alert.sh will probably need the portal fallback."
fi
info "Scripts only touch AZ_SUBSCRIPTION=\"$AZ_SUBSCRIPTION\" (override the env var to change it)."

# --- 2. Providers (the one mutating step) -------------------------------------------------
log "2/8 Resource providers (registering is idempotent and free; the only change this script makes)"
for ns in "${REQUIRED_PROVIDERS[@]}"; do
  state=$(azq provider show -n "$ns" --query registrationState -o tsv)
  if [[ $state == Registered ]]; then
    info "$ns: Registered"
  else
    az provider register -n "$ns" --only-show-errors >/dev/null
    info "$ns: $state -> registration requested (10-core.sh waits for it)"
  fi
done

# --- 3. Policy: allowed locations ---------------------------------------------------------
log "3/8 Policy assignments (including ones inherited from management groups)"
# --filter "atScope()" = every assignment that applies at subscription scope, including ones
# inherited from management groups (tenant-level policies). Check the scope column to see where
# each comes from. The CLI default sends atExactScope() (made at the subscription only) and
# --disable-scope-strict-match sends atScopeAndBelow(); both can miss an inherited region policy.
POLICY_FILTER="atScope()"
az policy assignment list --filter "$POLICY_FILTER" \
  --query "[].{displayName:displayName, name:name, scope:scope}" -o table || warn "could not list policy assignments"

# Azure for Students carries "Allowed resource deployment regions" (parameter "Allowed locations").
LOCQ="[?contains(displayName || '', 'region') || contains(displayName || '', 'Region') || contains(displayName || '', 'location') || contains(displayName || '', 'Location') || ends_with(policyDefinitionId || '', '${ALLOWED_LOC_DEF}')]"
NPOL=$(azq policy assignment list --filter "$POLICY_FILTER" --query "length(${LOCQ})" -o tsv) || NPOL=0
ALLOWED=""
ALLOWED_SRC=""
if [[ $NPOL -gt 0 ]]; then
  info "Location-type assignments ($NPOL):"
  az policy assignment list --filter "$POLICY_FILTER" \
    --query "${LOCQ}.{displayName:displayName, scope:scope, enforcementMode:enforcementMode, parameters:parameters}" -o json
  RAW=$(azq policy assignment list --filter "$POLICY_FILTER" \
    --query "${LOCQ}.join(',', parameters.listOfAllowedLocations.value || parameters.allowedLocations.value || \`[]\`)" -o tsv) || RAW=""
  got=0
  while IFS= read -r line; do
    [[ -z $line ]] && continue
    list=$(tr ',' '\n' <<<"$line" | norm_regions)
    if [[ $got -eq 0 ]]; then ALLOWED=$list; else ALLOWED=$(intersect "$ALLOWED" "$list"); fi
    got=$((got + 1))
  done <<<"$RAW"
  if [[ $got -gt 0 ]]; then
    ALLOWED_SRC="policy"
    info "Allowed regions (intersection of $got list(s)): $(csv "$ALLOWED")"
  else
    warn "Found location policies but could not read their region list. Read it from the JSON above"
    warn "(portal: Policy > Assignments > the assignment > Parameters) and set LOC/SWA_LOC by hand."
  fi
fi
if [[ -z $ALLOWED_SRC ]]; then
  [[ $NPOL -eq 0 ]] && warn "No allowed-locations policy visible. Azure for Students normally shows one named
      'Allowed resource deployment regions'. If a create later fails with RequestDisallowedByAzure or
      RequestDisallowedByPolicy, check the portal: Policy > Assignments."
  ALLOWED=$(azq account list-locations --query "[?metadata.regionType=='Physical'].name" -o tsv | norm_regions)
  ALLOWED_SRC="no readable policy; using all subscription regions"
fi

# --- 4. Flex Consumption ------------------------------------------------------------------
log "4/8 Functions Flex Consumption regions (python)"
FLEX=$(azq functionapp list-flexconsumption-locations --runtime python --query "[].name" -o tsv | norm_regions) || {
  warn "list-flexconsumption-locations failed (Microsoft.Web may still be registering; rerun in a minute)"
  FLEX=""
}
info "Flex (python) and allowed: $(csv "$(intersect "$ALLOWED" "$FLEX")")"

# --- 5. Container Apps --------------------------------------------------------------------
log "5/8 Container Apps environment regions"
ACA=$(azq provider show -n Microsoft.App \
  --query "resourceTypes[?resourceType=='managedEnvironments'].locations | [0]" -o tsv | norm_regions)
info "Container Apps and allowed: $(csv "$(intersect "$ALLOWED" "$ACA")")"

# --- 6. Static Web Apps -------------------------------------------------------------------
log "6/8 Static Web Apps regions"
SWA_REGIONS=$(azq provider show -n Microsoft.Web \
  --query "resourceTypes[?resourceType=='staticSites'].locations | [0]" -o tsv | norm_regions)
info "SWA regions: $(csv "$SWA_REGIONS")"
info "SWA and allowed: $(csv "$(intersect "$ALLOWED" "$SWA_REGIONS")")"

# --- 7. Cosmos DB free tier ---------------------------------------------------------------
log "7/8 Cosmos DB free tier (one per subscription)"
if FT=$(azq cosmosdb list --query "[?enableFreeTier].name" -o tsv 2>/dev/null); then
  if [[ -n $FT ]]; then COSMOS_FREE="already used by: $(csv "$FT")"; else COSMOS_FREE="available"; fi
else
  COSMOS_FREE="unknown (cosmosdb list failed; Microsoft.DocumentDB may still be registering)"
fi
info "$COSMOS_FREE"

# --- 8. Recommendation --------------------------------------------------------------------
log "8/8 Recommendation"
A_F_C=$(intersect "$(intersect "$ALLOWED" "$FLEX")" "$ACA")
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

STAMP=$(date '+%Y-%m-%d %H:%M')
cat <<EOF

==================== paste into issue #7 and docs/DECISIONS.md ====================
## ${STAMP} - Azure region and subscription preflight
Decision: LOC=${REC_LOC:-NONE}, SWA_LOC=${REC_SWA:-NONE}. ${WHY:-No region satisfies allowed + Container Apps.}
Why: offer quotaId=${QUOTA_ID}, spendingLimit=${SPEND_LIMIT}. Allowed regions (${ALLOWED_SRC}): $(csv "$ALLOWED").
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
