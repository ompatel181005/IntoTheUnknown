#!/usr/bin/env bash
# 05-oidc-test.sh (issue #7): can this tenant hold an app registration with a GitHub OIDC
# federated credential? Safe to rerun.
#
# - App "gh-planetx-$SUF". Its appId is saved to infra/.env.local (AZ_OIDC_APP_ID) on creation,
#   and only that ID is ever reused, after checking you are one of its owners.
# - Federated credential for repo:ompatel181005/IntoTheUnknown:ref:refs/heads/main.
# - Least privilege: AcrPush on the registry only (if 10-core.sh has created it; else rerun later).
#   No Contributor on the resource group. TODO(#23): grant a role scoped to the Container App.
# - Sets GitHub secrets AZURE_CLIENT_ID / AZURE_TENANT_ID / AZURE_SUBSCRIPTION_ID with gh
#   (or prints the commands if gh is missing or logged out).
# If the tenant blocks it (403 Authorization_RequestDenied): prints the GHCR plan B and exits 2.
# Any other failure (network, expired login, 5xx): prints the raw error and exits 1.
# On rerun the federated credential's subject, issuer and audience are verified and fixed.
#
# Usage:  bash infra/05-oidc-test.sh      (run again after 10-core.sh to grant AcrPush)
set -euo pipefail
# shellcheck source=infra/env.sh
source "$(dirname "$0")/env.sh"
require_az

ISSUER="https://token.actions.githubusercontent.com"
AUDIENCE="api://AzureADTokenExchange"
SUBJECT="repo:${GH_REPO}:ref:refs/heads/${GH_BRANCH}"
GHCR_IMAGE="ghcr.io/${GH_REPO%%/*}/planetx-api"
ERR=$(mktemp)
trap 'rm -f "$ERR"' EXIT

# A failed Entra call. Only a 403 (Authorization_RequestDenied / "Insufficient privileges", the
# usual answer when a university tenant stops students registering apps) means OIDC is blocked
# and plan B applies. Anything else (network, expired login, 5xx) prints the raw error, exit 1.
fail() { # what-failed
  if grep -qiE 'Authorization_RequestDenied|Insufficient privileges|Forbidden|\b403\b' "$ERR"; then
    plan_b "$1 was denied (403 Authorization_RequestDenied): the tenant does not allow this for your account."
  fi
  printf 'ERROR: %s failed, and not with a 403, so this does NOT show OIDC is blocked. Raw error:\n' "$1" >&2
  sed 's/^/    /' "$ERR" >&2
  printf 'If the login expired or is for the wrong tenant, run:  az login --tenant %s\nthen rerun this script.\n' \
    "$AZ_TENANT_ID" >&2
  exit 1
}

plan_b() {
  cat <<EOF

------------------------------------------------------------------------------------------
GitHub OIDC is BLOCKED here: $1
Use plan B (infra/README.md, "GitHub OIDC for CI"):
  - CI builds backend/ and pushes a PUBLIC image to GHCR with the built-in GITHUB_TOKEN
    (permissions: packages: write): ${GHCR_IMAGE}:<sha>
  - A laptop or Cloud Shell deploys it (no Azure secrets in GitHub, no local Docker):
      source infra/env.sh
      az containerapp update -g ${RG} -n ${API} --image ${GHCR_IMAGE}:<sha> --subscription "\$AZ_SUBSCRIPTION_ID"
  - Record "OIDC blocked -> GHCR plan B" in docs/DECISIONS.md and on issue #7.
------------------------------------------------------------------------------------------
EOF
  exit 2
}

log "Signed-in user"
ME=$(azq ad signed-in-user show --query id -o tsv 2>"$ERR") || fail "Reading the signed-in user"
info "object id $ME"

log "App registration $OIDC_APP_NAME"
if [[ -n ${AZ_OIDC_APP_ID:-} ]]; then
  [[ $AZ_OIDC_APP_ID =~ $GUID_RE ]] || die "AZ_OIDC_APP_ID in infra/.env.local is not a GUID: $AZ_OIDC_APP_ID"
  azq ad app show --id "$AZ_OIDC_APP_ID" --query appId -o tsv >/dev/null 2>"$ERR" ||
    die "App AZ_OIDC_APP_ID=$AZ_OIDC_APP_ID (infra/.env.local) is not readable: $(tr '\n' ' ' <"$ERR")
       Remove that line from infra/.env.local only if the app is really gone."
  OWNED=$(azq ad app owner list --id "$AZ_OIDC_APP_ID" --query "length([?id=='${ME}'])" -o tsv 2>"$ERR") ||
    die "Cannot list owners of app $AZ_OIDC_APP_ID: $(tr '\n' ' ' <"$ERR")"
  [[ $OWNED -gt 0 ]] || die "You are not an owner of app $AZ_OIDC_APP_ID. Refusing to reuse it."
  APP_ID=$AZ_OIDC_APP_ID
  info "reusing appId $APP_ID (from infra/.env.local; you are an owner)"
else
  # Never adopt an existing app by name: if one already has our name, a human decides.
  N=$(azq ad app list --display-name "$OIDC_APP_NAME" --query "length([?displayName=='${OIDC_APP_NAME}'])" \
    -o tsv 2>"$ERR") || fail "Listing app registrations"
  [[ $N -eq 0 ]] ||
    die "An app named $OIDC_APP_NAME exists but infra/.env.local has no AZ_OIDC_APP_ID. If it is yours,
       add AZ_OIDC_APP_ID=<its appId> to infra/.env.local and rerun (ownership is checked); otherwise change SUF."
  APP_ID=$(azq ad app create --display-name "$OIDC_APP_NAME" --sign-in-audience AzureADMyOrg \
    --query appId -o tsv 2>"$ERR") || fail "Creating the app registration"
  set_env_local AZ_OIDC_APP_ID "$APP_ID" ||
    die "Created app $APP_ID but could not save it. Add AZ_OIDC_APP_ID=$APP_ID to infra/.env.local by hand."
  info "created appId $APP_ID (saved to infra/.env.local as AZ_OIDC_APP_ID)"
fi

log "Service principal"
if SP_OID=$(azq ad sp show --id "$APP_ID" --query id -o tsv 2>/dev/null) && [[ -n $SP_OID ]]; then
  info "exists ($SP_OID)"
else
  SP_OID=$(azq ad sp create --id "$APP_ID" --query id -o tsv 2>"$ERR") ||
    fail "Creating the service principal"
  info "created ($SP_OID)"
fi

log "Federated credential $OIDC_CRED_NAME ($SUBJECT)"
FC_BODY=$(printf '{"issuer":"%s","subject":"%s","description":"GitHub Actions on %s","audiences":["%s"]}' \
  "$ISSUER" "$SUBJECT" "$GH_BRANCH" "$AUDIENCE")
# Existing credential as three lines: subject, issuer, audiences (comma-joined). Empty if none.
CUR=$(azq ad app federated-credential list --id "$APP_ID" \
  --query "[?name=='${OIDC_CRED_NAME}'] | [0].[subject, issuer, join(',', audiences || \`[]\`)]" -o tsv 2>"$ERR") ||
  fail "Listing federated credentials"
if [[ -n $CUR ]]; then
  { read -r CUR_SUB || true; read -r CUR_ISS || true; read -r CUR_AUD || true; } <<<"$CUR"
  if [[ $CUR_SUB == "$SUBJECT" && $CUR_ISS == "$ISSUER" && $CUR_AUD == "$AUDIENCE" ]]; then
    info "exists; subject, issuer and audience verified"
  else
    # The name is immutable, so update everything else in place.
    az ad app federated-credential update --id "$APP_ID" --federated-credential-id "$OIDC_CRED_NAME" \
      --parameters "$FC_BODY" -o none 2>"$ERR" ||
      fail "Updating the federated credential"
    info "updated (was subject=$CUR_SUB issuer=$CUR_ISS audience=$CUR_AUD)"
  fi
else
  az ad app federated-credential create --id "$APP_ID" \
    --parameters "{\"name\":\"${OIDC_CRED_NAME}\",${FC_BODY#\{}" -o none 2>"$ERR" ||
    fail "Creating the federated credential"
  info "created"
fi

log "Role assignment: AcrPush on registry $ACR (least privilege)"
ROLE_STATE="pending"
if ACR_ID=$(azsq acr show -g "$RG" -n "$ACR" --query id -o tsv 2>/dev/null) && [[ -n $ACR_ID ]]; then
  # --assignee-object-id + principal type avoids Graph lookups and new-SP propagation errors.
  HAVE=$(azsq role assignment list --assignee-object-id "$SP_OID" --role AcrPush --scope "$ACR_ID" \
    --fill-principal-name false --query "length(@)" -o tsv)
  if [[ $HAVE -gt 0 ]]; then
    info "exists"
  else
    if ! azs role assignment create --assignee-object-id "$SP_OID" --assignee-principal-type ServicePrincipal \
      --role AcrPush --scope "$ACR_ID" -o none 2>"$ERR"; then
      cat "$ERR" >&2
      die "AcrPush assignment failed. You need Owner (or User Access Administrator) on the subscription."
    fi
    info "created"
  fi
  ROLE_STATE="AcrPush on $ACR"
else
  warn "Registry $ACR does not exist yet. Run 10-core.sh, then rerun this script to grant AcrPush."
fi
# TODO(#23): once Container App $API exists, grant this app a role scoped to that app only (so CI can
#            run `az containerapp update`), e.g. Contributor at the app's resource ID. Not the RG.
#            If `az acr login` in CI needs registry read, add Reader on $ACR only.

log "GitHub secrets on $GH_REPO"
if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  gh secret set AZURE_CLIENT_ID --repo "$GH_REPO" --body "$APP_ID"
  gh secret set AZURE_TENANT_ID --repo "$GH_REPO" --body "$AZ_TENANT_ID"
  gh secret set AZURE_SUBSCRIPTION_ID --repo "$GH_REPO" --body "$AZ_SUBSCRIPTION_ID"
  info "set AZURE_CLIENT_ID, AZURE_TENANT_ID, AZURE_SUBSCRIPTION_ID"
else
  warn "gh is missing or not logged in. Run these where gh works (IDs, not passwords):"
  echo "  gh secret set AZURE_CLIENT_ID --repo $GH_REPO --body $APP_ID"
  echo "  gh secret set AZURE_TENANT_ID --repo $GH_REPO --body $AZ_TENANT_ID"
  echo "  gh secret set AZURE_SUBSCRIPTION_ID --repo $GH_REPO --body $AZ_SUBSCRIPTION_ID"
fi

cat <<EOF

OIDC: OK. App $OIDC_APP_NAME, credential subject $SUBJECT. Role: ${ROLE_STATE}.
Post "OIDC allowed" on issue #7 (no IDs needed there). The real proof is the first azure/login
run in the deploy workflow (#23): a wrong subject fails there, not here.
EOF
