#!/usr/bin/env bash
# 20-cost-alert.sh (issue #7): monthly cost budget on the resource group, emailing ALERT_EMAIL
# when actual cost passes 50%, 80% and 100% of BUDGET_AMOUNT (default $20). Safe to rerun.
#
# Usage:  ALERT_EMAIL=you@example.com bash infra/20-cost-alert.sh
#
# Uses `az rest` PUT on the Budgets REST API: `az consumption budget create` has no
# notifications flag, and create-with-rg (preview) does not document its --notifications keys.
# Azure for Students is listed as unsupported by Cost Management, so the API may refuse; the
# script then prints the portal fallback and exits 3.
set -euo pipefail
# shellcheck source=infra/env.sh
source "$(dirname "$0")/env.sh"

: "${ALERT_EMAIL:?Set ALERT_EMAIL, e.g. ALERT_EMAIL=you@example.com bash infra/20-cost-alert.sh}"
[[ $ALERT_EMAIL =~ ^[^@[:space:]\"]+@[^@[:space:]\"]+\.[^@[:space:]\"]+$ ]] ||
  die "ALERT_EMAIL does not look like an email address."
[[ $BUDGET_AMOUNT =~ ^[0-9]+([.][0-9]+)?$ ]] || die "BUDGET_AMOUNT must be a number (got $BUDGET_AMOUNT)."
require_az
exists az group show -n "$RG" || die "Resource group $RG not found. Run 10-core.sh first."

SUB_ID=$(azq account show --query id -o tsv)
QUOTA_ID=$(azq rest --method get --url "https://management.azure.com/subscriptions/${SUB_ID}?api-version=2022-12-01" \
  --query subscriptionPolicies.quotaId -o tsv) || QUOTA_ID="unknown"
API_VERSION="2024-08-01"
URL="https://management.azure.com/subscriptions/${SUB_ID}/resourceGroups/${RG}/providers/Microsoft.Consumption/budgets/${BUDGET_NAME}?api-version=${API_VERSION}"
ERR=$(mktemp)
trap 'rm -f "$ERR"' EXIT

fallback() {
  cat <<EOF

------------------------------------------------------------------------------------------
The budget API refused the request (offer quotaId: $QUOTA_ID).
$(sed 's/^/  /' "$ERR")

Portal fallback:
  1. portal.azure.com > Cost Management > Budgets > + Add. Scope: resource group $RG.
     Monthly, \$$BUDGET_AMOUNT, alerts at 50/80/100% of actual cost to your email.
  2. If the portal also says the offer is not supported (expected on Azure for Students),
     check the remaining credit on the Azure Sponsorships portal:
     https://www.microsoftazuresponsorships.com/  (sign in with the student account)
     The subscription is cancelled when the credit runs out: no surprise bill, but the demo dies.
  3. Either way: delete Front Door after local judging, and set Container Apps
     min-replicas back to 0 after judging (infra/README.md).
Record which option worked on issue #7.
------------------------------------------------------------------------------------------
EOF
  exit 3
}

if [[ $QUOTA_ID == AzureForStudents* ]]; then
  warn "Azure for Students: Cost Management lists this offer as unsupported. Trying the API anyway."
fi

log "Budget $BUDGET_NAME on $RG: \$$BUDGET_AMOUNT/month, alerts at 50/80/100% (actual cost)"
# On rerun keep the existing start date (it must stay inside the current period) and send the eTag.
ETAG=$(azq rest --method get --url "$URL" --query eTag -o tsv 2>/dev/null) || ETAG=""
START=""
if [[ -n $ETAG ]]; then
  START=$(azq rest --method get --url "$URL" --query properties.timePeriod.startDate -o tsv)
  info "exists; updating in place"
fi
MONTH_START=$(date -u +%Y-%m-01)
: "${START:=${MONTH_START}T00:00:00Z}"
END=$(date -u -d "$MONTH_START +1 year" +%Y-%m-%dT00:00:00Z)

notif() { # percent
  printf '"Actual_GreaterThan_%s_Percent":{"enabled":true,"operator":"GreaterThan","threshold":%s,"thresholdType":"Actual","contactEmails":["%s"],"locale":"en-us"}' \
    "$1" "$1" "$ALERT_EMAIL"
}
ETAG_PART=""
[[ -n $ETAG ]] && ETAG_PART="\"eTag\":\"${ETAG//\"/\\\"}\","
BODY=$(printf '{%s"properties":{"category":"Cost","amount":%s,"timeGrain":"Monthly","timePeriod":{"startDate":"%s","endDate":"%s"},"notifications":{%s,%s,%s}}}' \
  "$ETAG_PART" "$BUDGET_AMOUNT" "$START" "$END" "$(notif 50)" "$(notif 80)" "$(notif 100)")

azq rest --method put --url "$URL" --body "$BODY" \
  --query "{name:name, amount:properties.amount, timeGrain:properties.timeGrain, start:properties.timePeriod.startDate, end:properties.timePeriod.endDate}" \
  -o table 2>"$ERR" || fallback

cat <<EOF

Budget OK: $BUDGET_NAME on $RG, \$$BUDGET_AMOUNT/month, emails at 50/80/100% of actual cost.
Cost data can lag 8-72 h, so alerts are a backstop, not a live meter. Post "cost alert set" on issue #7.
EOF
