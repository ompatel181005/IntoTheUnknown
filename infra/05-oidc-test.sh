#!/usr/bin/env bash
# 05-oidc-test.sh (issue #7): can this tenant hold an app registration with a GitHub OIDC
# federated credential? Idempotent: reuses the app named $OIDC_APP_NAME if it exists.
#
# On success: grants the app Contributor on $RG and sets the GitHub repo secrets
#   AZURE_CLIENT_ID, AZURE_TENANT_ID, AZURE_SUBSCRIPTION_ID (IDs, not passwords) with gh.
# If blocked: prints the GHCR plan B and exits 2.
#
# Usage:  LOC=<from 00-preflight> bash infra/05-oidc-test.sh
# Needs: az login (Owner on the subscription for the role assignment); gh auth login for the
#        secrets step (if gh is missing or logged out, the gh commands are printed instead).
set -euo pipefail
# shellcheck source=infra/env.sh
source "$(dirname "$0")/env.sh"
require_az

ISSUER="https://token.actions.githubusercontent.com"
SUBJECT="repo:${GH_REPO}:ref:refs/heads/${GH_BRANCH}"
ERR=$(mktemp)
trap 'rm -f "$ERR"' EXIT

# One-line reason for a failed az call. University tenants usually stop students from
# registering apps; Graph then answers 403 Authorization_RequestDenied ("Insufficient privileges").
reason() { # what-failed
  if grep -qiE 'Authorization_RequestDenied|Insufficient privileges|Forbidden|\b403\b' "$ERR"; then
    echo "$1 was denied (403 Authorization_RequestDenied): the tenant does not allow this for your account."
  else
    echo "$1 failed: $(tr '\n' ' ' <"$ERR")"
  fi
}

plan_b() {
  cat <<EOF

------------------------------------------------------------------------------------------
GitHub OIDC is BLOCKED here: $1
Use plan B (infra/README.md, "GitHub OIDC for CI"):
  - CI builds backend/ and pushes a PUBLIC image to GHCR with the built-in GITHUB_TOKEN
    (permissions: packages: write): ghcr.io/${GH_REPO%%/*}/planetx-api:<sha>
  - A laptop or Cloud Shell deploys it (no Azure secrets in GitHub, no local Docker):
      az containerapp update -g ${RG} -n ${API} --image ghcr.io/${GH_REPO%%/*}/planetx-api:<sha>
  - Record "OIDC blocked -> GHCR plan B" in docs/DECISIONS.md and on issue #7.
------------------------------------------------------------------------------------------
EOF
  exit 2
}

log "App registration $OIDC_APP_NAME"
# --display-name may match by prefix, so filter for the exact name too.
EXACT="[?displayName=='${OIDC_APP_NAME}']"
N=$(azq ad app list --display-name "$OIDC_APP_NAME" --query "length(${EXACT})" -o tsv 2>"$ERR") ||
  plan_b "$(reason "Listing app registrations")"
if [[ $N -gt 0 ]]; then
  APP_ID=$(azq ad app list --display-name "$OIDC_APP_NAME" --query "${EXACT} | [0].appId" -o tsv)
  [[ $N -gt 1 ]] && warn "$N apps are named $OIDC_APP_NAME; using the first ($APP_ID)."
  info "reusing appId $APP_ID"
else
  APP_ID=$(azq ad app create --display-name "$OIDC_APP_NAME" --sign-in-audience AzureADMyOrg \
    --query appId -o tsv 2>"$ERR") ||
    plan_b "$(reason "Creating the app registration")"
  info "created appId $APP_ID"
fi

log "Service principal"
if SP_OID=$(azq ad sp show --id "$APP_ID" --query id -o tsv 2>/dev/null) && [[ -n $SP_OID ]]; then
  info "exists ($SP_OID)"
else
  SP_OID=$(azq ad sp create --id "$APP_ID" --query id -o tsv 2>"$ERR") ||
    plan_b "$(reason "Creating the service principal")"
  info "created ($SP_OID)"
fi

log "Federated credential $OIDC_CRED_NAME ($SUBJECT)"
FC_BODY=$(printf '{"issuer":"%s","subject":"%s","description":"GitHub Actions on %s","audiences":["api://AzureADTokenExchange"]}' \
  "$ISSUER" "$SUBJECT" "$GH_BRANCH")
CUR=$(azq ad app federated-credential list --id "$APP_ID" \
  --query "[?name=='${OIDC_CRED_NAME}'].subject | [0]" -o tsv 2>"$ERR") ||
  plan_b "$(reason "Listing federated credentials")"
if [[ $CUR == "$SUBJECT" ]]; then
  info "exists with the right subject"
elif [[ -n $CUR ]]; then
  # The name is immutable, so update everything else in place.
  az ad app federated-credential update --id "$APP_ID" --federated-credential-id "$OIDC_CRED_NAME" \
    --parameters "$FC_BODY" -o none 2>"$ERR" ||
    plan_b "$(reason "Updating the federated credential")"
  info "updated subject (was $CUR)"
else
  az ad app federated-credential create --id "$APP_ID" \
    --parameters "{\"name\":\"${OIDC_CRED_NAME}\",${FC_BODY#\{}" -o none 2>"$ERR" ||
    plan_b "$(reason "Creating the federated credential")"
  info "created"
fi

# The role assignment needs the resource group as its scope (same idempotent create as 10-core.sh).
log "Resource group $RG"
if exists az group show -n "$RG"; then
  info "exists"
else
  az group create -n "$RG" -l "$LOC" -o none
  info "created in $LOC"
fi
RG_ID=$(azq group show -n "$RG" --query id -o tsv)

log "Role assignment: Contributor on $RG"
# --assignee-object-id + principal type avoids Graph lookups and new-SP propagation errors.
HAVE=$(azq role assignment list --assignee-object-id "$SP_OID" --role Contributor --scope "$RG_ID" \
  --fill-principal-name false --query "length(@)" -o tsv)
if [[ $HAVE -gt 0 ]]; then
  info "exists"
else
  if ! az role assignment create --assignee-object-id "$SP_OID" --assignee-principal-type ServicePrincipal \
    --role Contributor --scope "$RG_ID" -o none 2>"$ERR"; then
    cat "$ERR" >&2
    die "Role assignment failed. The app registration and federated credential work, but you need Owner
       (or User Access Administrator) on the subscription to grant access. Ask the subscription owner to run this."
  fi
  info "created"
fi
# TODO(#23): pushing to ACR may also need AcrPush on $ACR; check when the deploy workflow first runs.

TENANT_ID=$(azq account show --query tenantId -o tsv)
SUB_ID=$(azq account show --query id -o tsv)

log "GitHub secrets on $GH_REPO"
if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  gh secret set AZURE_CLIENT_ID --repo "$GH_REPO" --body "$APP_ID"
  gh secret set AZURE_TENANT_ID --repo "$GH_REPO" --body "$TENANT_ID"
  gh secret set AZURE_SUBSCRIPTION_ID --repo "$GH_REPO" --body "$SUB_ID"
  info "set AZURE_CLIENT_ID, AZURE_TENANT_ID, AZURE_SUBSCRIPTION_ID"
else
  warn "gh is missing or not logged in. Run these where gh works (they are IDs, not passwords):"
  echo "  gh secret set AZURE_CLIENT_ID --repo $GH_REPO --body $APP_ID"
  echo "  gh secret set AZURE_TENANT_ID --repo $GH_REPO --body $TENANT_ID"
  echo "  gh secret set AZURE_SUBSCRIPTION_ID --repo $GH_REPO --body $SUB_ID"
fi

cat <<EOF

OIDC: OK. App $OIDC_APP_NAME, credential subject $SUBJECT, Contributor on $RG.
Post "OIDC allowed" on issue #7 (no IDs needed there). The real proof is the first azure/login
run in the deploy workflow (#23): a wrong subject fails there, not here.
EOF
