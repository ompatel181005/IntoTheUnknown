#!/usr/bin/env bash
# check-scripts.sh: offline checks for infra/*.sh. Makes no az calls.
#   1. bash -n on every script.
#   2. Subscription-scoped az commands must be pinned: called through azs/azsq (env.sh), or with
#      --subscription on the same line. Bare az/azq is allowed only for tenant-level groups
#      (account, ad, rest, extension, version).
#   3. azs/azsq must not wrap tenant-level groups (they reject --subscription).
#   4. Every ARM URL names the subscription explicitly: /subscriptions/${AZ_SUBSCRIPTION_ID}.
# Usage:  bash infra/check-scripts.sh
set -euo pipefail
cd "$(dirname "$0")"
FILES=(env.sh [0-9][0-9]-*.sh check-scripts.sh)
SCOPED='group|storage|acr|monitor|containerapp|staticwebapp|provider|policy|cosmosdb|role|functionapp|consumption|resource|deployment|afd|network'
TENANT='account|ad|rest|extension|version'
fail=0

for f in "${FILES[@]}"; do
  bash -n "$f" || { echo "FAIL: bash -n $f"; fail=1; }
done

# Code lines only: drop comment lines (grep -n prefixes "file:line:").
code() { grep -nE "$1" "${FILES[@]:0:${#FILES[@]}-1}" | grep -vE '^[^:]+:[0-9]+:[[:space:]]*#' || true; }

bad=$(code "(^|[^[:alnum:]_-])azq?[[:space:]]+(${SCOPED})([[:space:]]|$)" | grep -v -- '--subscription' || true)
if [[ -n $bad ]]; then
  printf 'FAIL: subscription-scoped az call without --subscription (use azs/azsq):\n%s\n' "$bad"
  fail=1
fi

bad=$(code "(^|[^[:alnum:]_-])azsq?[[:space:]]+(${TENANT})([[:space:]]|$)")
if [[ -n $bad ]]; then
  printf 'FAIL: azs/azsq used for a tenant-level command:\n%s\n' "$bad"
  fail=1
fi

bad=$(code 'management\.azure\.com/subscriptions/' | grep -v 'subscriptions/\${AZ_SUBSCRIPTION_ID}' || true)
if [[ -n $bad ]]; then
  printf 'FAIL: ARM URL without ${AZ_SUBSCRIPTION_ID}:\n%s\n' "$bad"
  fail=1
fi

if [[ $fail -eq 0 ]]; then echo "check-scripts: ok (${#FILES[@]} files)"; fi
exit "$fail"
