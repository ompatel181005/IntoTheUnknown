#!/usr/bin/env bash
# 20-cost-alert.sh (issue #7): monthly cost budget on the resource group, emailing ALERT_EMAIL
# when actual cost passes 50%, 80% and 100% of BUDGET_AMOUNT (default $20). Safe to rerun:
# each run sets the start to the first day of the current month and the end one year later.
#
# Usage:  ALERT_EMAIL=you@example.com bash infra/20-cost-alert.sh
#
# Uses `az rest` PUT on the Budgets REST API (subscription ID explicit in the URL):
# `az consumption budget create` has no notifications flag, and create-with-rg (preview) does
# not document its --notifications keys. Azure for Students may not be supported for budgets;
# if the API refuses, the script prints the portal fallback and exits 3.
set -euo pipefail
# shellcheck source=infra/env.sh
source "$(dirname "$0")/env.sh"

: "${ALERT_EMAIL:?Set ALERT_EMAIL, e.g. ALERT_EMAIL=you@example.com bash infra/20-cost-alert.sh}"
[[ $ALERT_EMAIL =~ ^[^@[:space:]\"]+@[^@[:space:]\"]+\.[^@[:space:]\"]+$ ]] ||
  die "ALERT_EMAIL does not look like an email address."
[[ $ALERT_EMAIL != *"'"* ]] || die "ALERT_EMAIL must not contain a single quote."
ALERT_EMAIL=${ALERT_EMAIL,,}   # compared against the API response, so keep one spelling
[[ $BUDGET_AMOUNT =~ ^[0-9]+([.][0-9]+)?$ ]] || die "BUDGET_AMOUNT must be a number (got $BUDGET_AMOUNT)."
require_az
exists azs group show -n "$RG" || die "Resource group $RG not found. Run 10-core.sh first."

QUOTA_ID=$(azq rest --method get --url "https://management.azure.com/subscriptions/${AZ_SUBSCRIPTION_ID}?api-version=2022-12-01" \
  --query subscriptionPolicies.quotaId -o tsv) || QUOTA_ID="unknown"
API_VERSION="2024-08-01"
URL="https://management.azure.com/subscriptions/${AZ_SUBSCRIPTION_ID}/resourceGroups/${RG}/providers/Microsoft.Consumption/budgets/${BUDGET_NAME}?api-version=${API_VERSION}"
ERR=$(mktemp)
trap 'rm -f "$ERR"' EXIT

fallback() {
  cat <<EOF

------------------------------------------------------------------------------------------
The budget API refused the request (offer quotaId: $QUOTA_ID). API response:
$(sed 's/^/  /' "$ERR")

Portal fallback:
  1. portal.azure.com > Cost Management > Budgets > + Add. Scope: resource group $RG.
     Monthly, \$$BUDGET_AMOUNT, alerts at 50/80/100% of actual cost to your email.
  2. If the portal also says the offer is not supported, check the remaining credit on the
     Azure Sponsorships portal: https://www.microsoftazuresponsorships.com/ (student account).
     When the credit runs out the subscription is cancelled and the demo stops.
  3. Either way: delete Front Door after local judging, and set Container Apps
     min-replicas back to 0 after judging (infra/README.md).
Record which option worked on issue #7.
------------------------------------------------------------------------------------------
EOF
  exit 3
}

if [[ $QUOTA_ID == AzureForStudents* ]]; then
  info "Azure for Students may not be supported for budgets. Trying the API; the fallback follows if it refuses."
fi

log "Budget $BUDGET_NAME on $RG: \$$BUDGET_AMOUNT/month, alerts at 50/80/100% (actual cost)"
# An existing budget is updated in place; its eTag is sent for concurrency control.
ETAG=$(azq rest --method get --url "$URL" --query eTag -o tsv 2>/dev/null) || ETAG=""
if [[ -n $ETAG ]]; then info "exists; updating it"; else info "not found; creating it"; fi
MONTH_START=$(date -u +%Y-%m-01)
START="${MONTH_START}T00:00:00Z"
END=$(date -u -d "$MONTH_START +1 year" +%Y-%m-%dT00:00:00Z)

notif() { # percent
  printf '"Actual_GreaterThan_%s_Percent":{"enabled":true,"operator":"GreaterThan","threshold":%s,"thresholdType":"Actual","contactEmails":["%s"],"locale":"en-us"}' \
    "$1" "$1" "$ALERT_EMAIL"
}
ETAG_PART=""
[[ -n $ETAG ]] && ETAG_PART="\"eTag\":\"${ETAG//\"/\\\"}\","
BODY=$(printf '{%s"properties":{"category":"Cost","amount":%s,"timeGrain":"Monthly","timePeriod":{"startDate":"%s","endDate":"%s"},"notifications":{%s,%s,%s}}}' \
  "$ETAG_PART" "$BUDGET_AMOUNT" "$START" "$END" "$(notif 50)" "$(notif 80)" "$(notif 100)")

# Check what the API actually stored, not what we sent. One line per field; the last is the
# thresholds of enabled Actual-cost alerts that go to ALERT_EMAIL.
RESULT=$(azq rest --method put --url "$URL" --body "$BODY" \
  --query "[name, to_string(properties.amount), properties.timeGrain, properties.timePeriod.startDate, properties.timePeriod.endDate, join(',', values(properties.notifications || \`{}\`)[?enabled && thresholdType=='Actual' && contains(contactEmails || \`[]\`, '${ALERT_EMAIL}')].to_string(threshold))]" \
  -o tsv 2>"$ERR") || fallback
{ read -r R_NAME || true; read -r R_AMOUNT || true; read -r R_GRAIN || true; read -r R_START || true; read -r R_END || true; read -r R_THR || true; } <<<"$RESULT"
num() { sed 's/\.0*$//'; }
R_THR=$(tr ',' '\n' <<<"$R_THR" | sed '/^$/d' | num | sort -n | paste -sd, -)

cat <<EOF
    API returned: name=$R_NAME amount=$R_AMOUNT grain=$R_GRAIN start=$R_START end=$R_END
    alert thresholds to ALERT_EMAIL (enabled, actual cost): ${R_THR:-(none)}
EOF
[[ $R_NAME == "$BUDGET_NAME" && $(num <<<"$R_AMOUNT") == "$(num <<<"$BUDGET_AMOUNT")" && $R_GRAIN == Monthly ]] ||
  die "The API accepted the budget but returned different settings (see above). Check it in the portal."
[[ $R_THR == "50,80,100" ]] ||
  die "The API accepted the budget but the alerts to ALERT_EMAIL are '${R_THR:-none}', not 50,80,100. Check the portal."

cat <<EOF

Budget OK, verified from the API response: $BUDGET_NAME on $RG, \$$BUDGET_AMOUNT/month, emails at
50/80/100% of actual cost. Cost data can lag 8-72 h, so alerts are a backstop, not a live meter.
Post "cost alert set" on issue #7.
EOF
