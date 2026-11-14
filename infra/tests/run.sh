#!/usr/bin/env bash
# Offline behavioral checks. Only the fake az and gh below are on the command path.
set -euo pipefail
TEST_DIR=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$TEST_DIR/../.." && pwd)
CASE_DIR=$(mktemp -d)
trap 'rm -f "$CASE_DIR"/*; rmdir "$CASE_DIR"' EXIT
export PATH="$TEST_DIR/fakebin:$PATH"
[[ $(command -v az) == "$TEST_DIR/fakebin/az" ]] || exit 1
[[ $(command -v gh) == "$TEST_DIR/fakebin/gh" ]] || exit 1
passed=0

run_case() { # label expected-exit script [ENV=value ...]
  local label=$1 expected=$2 script=$3 rc=0
  shift 3
  rm -f "$CASE_DIR"/*
  (
    # No ambient test settings or real subscription IDs can enter a case.
    for v in ${!FAKE_@}; do unset "$v"; done
    unset AZ_SUBSCRIPTION_ID AZ_TENANT_ID AZ_OIDC_APP_ID LOC SWA_LOC SUF ALLOW_UNVERIFIED_REGION
    export FAKE_LOG="$CASE_DIR/calls" AZ_ENV_LOCAL="$CASE_DIR/env"
    export FAKE_SUB_ID=11111111-2222-3333-4444-555555555555
    export FAKE_TENANT=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee
    printf 'AZ_SUBSCRIPTION_ID=%s\nAZ_TENANT_ID=%s\n' "$FAKE_SUB_ID" "$FAKE_TENANT" >"$AZ_ENV_LOCAL"
    for setting in "$@"; do export "$setting"; done
    cd "$REPO"
    bash "infra/$script"
  ) >"$CASE_DIR/output" 2>&1 || rc=$?
  if [[ $rc -ne $expected ]] || [[ -s $CASE_DIR/calls.unpinned || -s $CASE_DIR/calls.leak ]]; then
    printf 'FAIL: %s (exit %s; expected %s)\n' "$label" "$rc" "$expected"
    cat "$CASE_DIR/output"
    exit 1
  fi
  if grep -q 'SECRET-KEY-DO-NOT-PRINT' "$CASE_DIR/output"; then
    echo "FAIL: $label leaked the fixture key"; exit 1
  fi
  passed=$((passed + 1))
  printf 'PASS: %s\n' "$label"
}
has() { grep -qE -- "$1" "$CASE_DIR/$2" || { echo "FAIL: missing $1 in $2"; exit 1; }; }
lacks() { if grep -qE -- "$1" "$CASE_DIR/$2"; then echo "FAIL: unexpected $1 in $2"; exit 1; fi; }

run_case 'preflight selects allowed westus and Blob website' 0 00-preflight.sh
has 'export LOC=westus SWA_LOC=none' output
run_case 'unreadable policy withholds recommendation' 4 00-preflight.sh FAKE_POLICY=fail
lacks 'export LOC=westus' output
run_case 'subscription ID mismatch stops before mutations' 1 10-core.sh LOC=westus FAKE_ID_OUT=wrong
lacks '^(group|storage|deployment|ad) ' calls
run_case 'tenant mismatch stops before mutations' 1 10-core.sh LOC=westus FAKE_TENANT_OUT=wrong
lacks '^group ' calls
run_case 'university subscription is refused' 1 10-core.sh LOC=westus FAKE_SUB_NAME=UIC-ACCC-WVD
lacks '^group ' calls
run_case 'missing location is refused' 1 10-core.sh
run_case 'unreadable policy blocks creation' 1 10-core.sh LOC=westus FAKE_POLICY=fail
lacks '^group create' calls
run_case 'disallowed location blocks creation' 1 10-core.sh LOC=eastus
lacks '^group create' calls
run_case 'stricter resource-group policy blocks later resources' 1 10-core.sh LOC=westus FAKE_RG_ALLOWED=francecentral
has '^group create' calls
lacks '^monitor .*create' calls
run_case 'explicit policy override allows known location' 0 10-core.sh LOC=westus FAKE_POLICY=fail ALLOW_UNVERIFIED_REGION=1
has 'NOT confirmed' output
run_case 'first creation uses ARM key resolution and static website' 0 10-core.sh LOC=westus
has '^deployment group create .*core-environment' calls
has '^storage blob service-properties update .*--auth-mode login' calls
lacks 'get-shared-keys|logs-workspace-key|^staticwebapp create' calls
run_case 'rerun verifies existing configuration without recreating resources' 0 10-core.sh LOC=westus FAKE_EXISTS=yes FAKE_CORS=1
lacks '^deployment group create|^acr create|cors-rule add' calls
run_case 'rerun refuses wrong storage SKU' 1 10-core.sh LOC=westus FAKE_EXISTS=yes FAKE_SA_SKU=Standard_GRS
run_case 'rerun refuses weak TLS' 1 10-core.sh LOC=westus FAKE_EXISTS=yes FAKE_TLS=TLS1_0
run_case 'rerun refuses HTTP storage' 1 10-core.sh LOC=westus FAKE_EXISTS=yes FAKE_HTTPS=false
run_case 'rerun refuses mismatched log workspace' 1 10-core.sh LOC=westus FAKE_EXISTS=yes FAKE_CAE_WS=other
run_case 'incorrect website fallback is detected' 1 10-core.sh LOC=westus FAKE_WEB_ERROR=other.html
run_case 'OIDC permission denial offers plan B' 2 05-oidc-test.sh FAKE_OIDC=deny
has 'OIDC is BLOCKED' output
run_case 'OIDC network error does not claim tenant denial' 1 05-oidc-test.sh FAKE_OIDC=neterr
lacks 'OIDC is BLOCKED' output
run_case 'OIDC refuses adoption by display name' 1 05-oidc-test.sh FAKE_OIDC=ok FAKE_NAME_EXISTS=1
lacks '^ad app create' calls
run_case 'OIDC repairs issuer and grants only registry AcrPush' 0 05-oidc-test.sh FAKE_OIDC=ok FAKE_FC=badiss FAKE_ACR=exists
has '^ad app federated-credential update' calls
has '^role assignment create .*--role AcrPush --scope /subscriptions/.*/registries/' calls
lacks 'Contributor' calls
run_case 'OIDC repairs audience' 0 05-oidc-test.sh FAKE_OIDC=ok FAKE_FC=badaud
has '^ad app federated-credential update' calls
run_case 'budget rejection reports fallback' 3 20-cost-alert.sh ALERT_EMAIL=student@example.edu FAKE_EXISTS=yes
run_case 'budget verifies returned thresholds and email filter' 0 20-cost-alert.sh ALERT_EMAIL=student@example.edu FAKE_EXISTS=yes FAKE_BUDGET=ok
has 'contains\(contactEmails' calls.put
has 'Budget OK, verified' output
run_case 'budget rejects missing alert thresholds' 1 20-cost-alert.sh ALERT_EMAIL=student@example.edu FAKE_EXISTS=yes FAKE_BUDGET=ok FAKE_THR=50,100
run_case 'budget rejects incorrect amount' 1 20-cost-alert.sh ALERT_EMAIL=student@example.edu FAKE_EXISTS=yes FAKE_BUDGET=ok FAKE_AMOUNT=25
printf '\n%s offline scenarios passed; no Azure or GitHub requests made.\n' "$passed"
