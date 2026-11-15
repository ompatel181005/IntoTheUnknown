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
    unset AZ_SUBSCRIPTION_ID AZ_TENANT_ID AZ_OIDC_APP_ID LOC SWA_LOC SUF FRONTEND_HOST ALLOW_UNVERIFIED_REGION SOURCE_REF APP_MODE APP_MIN_REPLICAS MIN_REPLICAS
    export FAKE_LOG="$CASE_DIR/calls" AZ_ENV_LOCAL="$CASE_DIR/env"
    export FAKE_SUB_ID=11111111-2222-3333-4444-555555555555
    export FAKE_TENANT=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee
    printf 'AZ_SUBSCRIPTION_ID=%s\nAZ_TENANT_ID=%s\n' "$FAKE_SUB_ID" "$FAKE_TENANT" >"$AZ_ENV_LOCAL"
    for setting in "$@"; do export "$setting"; done
    curl() {
      [[ $* == *https://app.test.invalid/api/health* ]] || { echo 'Unexpected curl URL in offline test' >&2; return 97; }
      printf '%s\n' "$*" >> "$FAKE_LOG.curl"
      printf '{"ok":true}\n'
    }
    export -f curl
    # Python ARM payloads are tested independently with mocked HTTP; do not call Azure here.
    python() {
      if [[ $1 == */deploy_app.py || $1 == *\\deploy_app.py ]]; then
        printf 'python-deploy-app %s\n' "$*" >> "$FAKE_LOG"
      else
        command python "$@"
      fi
    }
    export -f python
    cd "$REPO"
    local args=()
    [[ $script != 30-app.sh && $script != 40-watcher.sh ]] || args+=("${APP_MODE:---plan}")
    bash "infra/$script" ${args[@]+"${args[@]}"}  # bash 3.2: empty array + set -u
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

run_case 'preflight selects allowed westus and combined-container hosting' 0 00-preflight.sh
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
run_case 'first creation uses ARM key resolution and combined-container hosting' 0 10-core.sh LOC=westus
has '^deployment group create .*core-environment' calls
lacks 'get-shared-keys|logs-workspace-key|^staticwebapp create|^storage blob service-properties update' calls
run_case 'explicit Blob alternative enables the static website' 0 10-core.sh LOC=westus FRONTEND_HOST=blob
has '^storage blob service-properties update .*--auth-mode login' calls
run_case 'rerun verifies existing configuration without recreating resources' 0 10-core.sh LOC=westus FAKE_EXISTS=yes FAKE_CORS=1
lacks '^deployment group create|^acr create|cors-rule add' calls
run_case 'rerun refuses wrong storage SKU' 1 10-core.sh LOC=westus FAKE_EXISTS=yes FAKE_SA_SKU=Standard_GRS
run_case 'rerun refuses weak TLS' 1 10-core.sh LOC=westus FAKE_EXISTS=yes FAKE_TLS=TLS1_0
run_case 'rerun refuses HTTP storage' 1 10-core.sh LOC=westus FAKE_EXISTS=yes FAKE_HTTPS=false
run_case 'rerun refuses mismatched log workspace' 1 10-core.sh LOC=westus FAKE_EXISTS=yes FAKE_CAE_WS=other
run_case 'incorrect website fallback is detected' 1 10-core.sh LOC=westus FRONTEND_HOST=blob FAKE_WEB_ERROR=other.html
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
run_case 'app plan performs no Azure calls' 0 30-app.sh
[[ ! -s $CASE_DIR/calls ]] || { echo 'FAIL: plan contacted Azure'; exit 1; }
has 'Scale: 0 minimum / 1 maximum' output
run_case 'app apply refuses university subscription before build' 1 30-app.sh APP_MODE=--apply FAKE_SUB_NAME=UIC-ACCC-WVD
lacks '^acr build|^containerapp create' calls
run_case 'app apply refuses missing core resources' 1 30-app.sh APP_MODE=--apply
has 'resource group is absent' output
lacks '^acr build|^containerapp create' calls
run_case 'app apply refuses disabled ARM tokens before build' 1 30-app.sh APP_MODE=--apply FAKE_EXISTS=yes FAKE_ARM_AUTH=disabled
has 'ARM-token authentication must be enabled' output
lacks '^acr build|^containerapp create' calls
run_case 'deploy-only refuses a missing image without building or creating an app' 1 30-app.sh APP_MODE=--deploy-only FAKE_EXISTS=yes FAKE_IMAGE=missing
has 'selected image is absent' output
lacks '^acr build|^containerapp create' calls
run_case 'deploy-only refuses malformed registry digest' 1 30-app.sh APP_MODE=--deploy-only FAKE_EXISTS=yes FAKE_DIGEST=invalid
has 'invalid image digest' output
lacks '^acr build|^containerapp update' calls
run_case 'deploy-only updates existing app with managed identity and verifies health' 0 30-app.sh APP_MODE=--deploy-only FAKE_EXISTS=yes
lacks '^acr build|^containerapp create' calls
has '^python-deploy-app .*--identity-id /subscriptions/' calls
has '^role assignment create .*--role AcrPull --scope /subscriptions/.*/registries/' calls
has '^role assignment create .*--role Storage Blob Data Contributor --scope /subscriptions/.*/storageAccounts/' calls
lacks '^containerapp identity assign .*--system-assigned' calls
has 'https://app.test.invalid/api/health' calls.curl
run_case 'CI setup refuses incorrect federation before grants or secrets' 1 06-ci-identity.sh FAKE_EXISTS=yes FAKE_CI_SUBJECT=repo:other/project:ref:refs/heads/main
has 'federation does not match' output
lacks '^role assignment create' calls
lacks 'secret set' calls.gh
run_case 'CI setup grants only scoped roles and uses main-only federation' 0 06-ci-identity.sh FAKE_EXISTS=yes
has '^role assignment create .*--role Container Apps Contributor --scope /subscriptions/.*/containerApps/' calls
has '^role assignment create .*--role Managed Identity Operator --scope /subscriptions/.*/userAssignedIdentities/' calls
lacks '^role assignment create .*--scope /subscriptions/[^/]+$' calls
has 'variable set APP_MIN_REPLICAS .*--body 1' calls.gh
has 'api repos/ompatel181005/IntoTheUnknown/actions/oidc/customization/sub' calls.gh
IMMUTABLE_SUBJECT=repo:ompatel181005@156618510/IntoTheUnknown@1457967493:ref:refs/heads/main
run_case 'CI setup creates exact immutable main trust from metadata' 0 06-ci-identity.sh FAKE_GH_OIDC=immutable "FAKE_CI_SUBJECT=$IMMUTABLE_SUBJECT" FAKE_ACR=exists
has "^identity federated-credential create .*--subject $IMMUTABLE_SUBJECT --audiences" calls
run_case 'CI setup reruns with existing immutable trust' 0 06-ci-identity.sh FAKE_EXISTS=yes FAKE_GH_OIDC=immutable "FAKE_CI_SUBJECT=$IMMUTABLE_SUBJECT"
lacks '^identity federated-credential create' calls
run_case 'CI setup refuses legacy trust for immutable metadata' 1 06-ci-identity.sh FAKE_EXISTS=yes FAKE_GH_OIDC=immutable
has 'federation does not match' output
lacks '^role assignment create' calls
lacks 'secret set|variable set' calls.gh
for metadata in unavailable custom missing wrong-type; do
  run_case "CI setup refuses $metadata metadata before changes" 1 06-ci-identity.sh "FAKE_GH_OIDC=$metadata"
  lacks '^identity .*create|^role assignment create' calls
  lacks 'secret set|variable set' calls.gh
done
for prefix in \
  repo:other@156618510/IntoTheUnknown@1457967493 \
  repo:ompatel181005@156618510/other@1457967493 \
  repo:ompatel181005/IntoTheUnknown \
  repo:ompatel181005@wrong/IntoTheUnknown@1457967493 \
  repo:ompatel181005@156618510/IntoTheUnknown@0 \
  'repo:ompatel181005@156618510/IntoTheUnknown@1457967493:environment:production' \
  'repo:ompatel181005@156618510/IntoTheUnknown@*'; do
  run_case "CI setup refuses unexpected immutable prefix $prefix" 1 06-ci-identity.sh FAKE_GH_OIDC=immutable "FAKE_GH_PREFIX=$prefix"
  lacks '^identity .*create|^role assignment create' calls
  lacks 'secret set|variable set' calls.gh
done
run_case 'CI setup refuses foreign legacy prefix before changes' 1 06-ci-identity.sh FAKE_GH_PREFIX=repo:other/project
lacks '^identity .*create|^role assignment create' calls
lacks 'secret set|variable set' calls.gh

run_case 'watcher default plan performs no Azure calls' 0 40-watcher.sh
has 'PLAN ONLY' output
[[ ! -s $CASE_DIR/calls ]] || { echo 'FAIL: watcher plan called Azure'; exit 1; }
run_case 'watcher refuses nonreviewed region before credentials or mutations' 1 40-watcher.sh APP_MODE=--apply LOC=eastus
has 'Reviewed watcher region is westus' output

printf '\n%s offline scenarios passed; no Azure or GitHub requests made.\n' "$passed"
