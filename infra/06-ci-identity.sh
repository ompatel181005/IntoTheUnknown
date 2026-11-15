#!/usr/bin/env bash
# One-time main-only GitHub OIDC setup. No app registration or password required.
set -euo pipefail
source "$(dirname "$0")/env.sh"
require_az
command -v gh >/dev/null 2>&1 || die 'GitHub CLI is required to store the Azure IDs.'
gh auth status >/dev/null 2>&1 || die 'GitHub CLI is not authenticated.'
MIN=${APP_MIN_REPLICAS:-1}
[[ $MIN == 0 || $MIN == 1 ]] || die 'APP_MIN_REPLICAS must be 0 or 1.'
# Resolve the active prefix, not a preview or guessed numeric IDs. Custom claim
# templates can change branch semantics, so they require a separate review.
OIDC=$(gh api "repos/$GH_REPO/actions/oidc/customization/sub" \
  --jq 'if .use_default == true and (.use_immutable_subject | type) == "boolean" and (.sub_claim_prefix | type) == "string" then (.use_immutable_subject | tostring) + "\n" + .sub_claim_prefix else error("Unsupported OIDC subject configuration") end') \
  || die 'Cannot read a supported default GitHub OIDC subject configuration.'
IMMUTABLE=${OIDC%%$'\n'*}
PREFIX=${OIDC#*$'\n'}
if [[ $IMMUTABLE == false ]]; then
  [[ $PREFIX == "repo:$GH_REPO" ]] || die 'Unexpected legacy GitHub OIDC prefix.'
elif [[ $IMMUTABLE == true ]]; then
  [[ $PREFIX =~ ^repo:([^@/:]+)@([1-9][0-9]*)/([^@/:]+)@([1-9][0-9]*)$ ]] \
    || die 'Malformed immutable GitHub OIDC prefix.'
  [[ ${BASH_REMATCH[1]}/${BASH_REMATCH[3]} == "$GH_REPO" ]] \
    || die 'GitHub OIDC prefix belongs to another repository.'
else
  die 'Unexpected GitHub OIDC subject configuration.'
fi
SUBJECT="$PREFIX:ref:refs/heads/main"
CI_IDENTITY=id-planetx-github
if ! exists azs identity show -g "$RG" -n "$CI_IDENTITY"; then
  LOCATION=$(azsq containerapp env show -g "$RG" -n "$CAE" --query location -o tsv | norm_regions)
  azs identity create -g "$RG" -n "$CI_IDENTITY" -l "$LOCATION" -o none
fi
CI_PRINCIPAL=$(azsq identity show -g "$RG" -n "$CI_IDENTITY" --query principalId -o tsv)
ISSUER=https://token.actions.githubusercontent.com
AUDIENCE=api://AzureADTokenExchange
if ! exists azs identity federated-credential show -g "$RG" --identity-name "$CI_IDENTITY" -n github-main; then
  azs identity federated-credential create -g "$RG" --identity-name "$CI_IDENTITY" -n github-main \
    --issuer "$ISSUER" --subject "$SUBJECT" --audiences "$AUDIENCE" -o none
fi
TRUST=$(azsq identity federated-credential show -g "$RG" --identity-name "$CI_IDENTITY" -n github-main \
  --query "[issuer,subject,join(',',audiences)]" -o tsv)
[[ $TRUST == "$ISSUER"$'\n'"$SUBJECT"$'\n'"$AUDIENCE" ]] || die 'Existing federation does not match this repository main branch.'
ACR_ID=$(azsq acr show -g "$RG" -n "$ACR" --query id -o tsv)
APP_ID=$(azsq containerapp show -g "$RG" -n "$API" --query id -o tsv)
RUNTIME_ID=$(azsq identity show -g "$RG" -n "$APP_IDENTITY" --query id -o tsv)
ENV_ID=$(azsq containerapp env show -g "$RG" -n "$CAE" --query id -o tsv)
[[ -n $CI_PRINCIPAL && -n $ACR_ID && -n $APP_ID && -n $RUNTIME_ID && -n $ENV_ID ]] || die 'Core resources or identity are missing.'
for spec in "AcrPush|$ACR_ID" "Reader|$ACR_ID" "Container Apps Contributor|$APP_ID" "Managed Identity Operator|$RUNTIME_ID" "Reader|$ENV_ID"; do
  role=${spec%%|*}; scope=${spec#*|}
  HAVE=$(azsq role assignment list --assignee-object-id "$CI_PRINCIPAL" --scope "$scope" --role "$role" --fill-principal-name false --query 'length(@)' -o tsv)
  if [[ $HAVE -eq 0 ]]; then
    azs role assignment create --assignee-object-id "$CI_PRINCIPAL" --assignee-principal-type ServicePrincipal --role "$role" --scope "$scope" -o none
  fi
  info "CI role configured: $role (project resource scope)."
done
azs identity show -g "$RG" -n "$CI_IDENTITY" --query clientId -o tsv | gh secret set AZURE_CLIENT_ID --repo "$GH_REPO"
printf '%s' "$AZ_TENANT_ID" | gh secret set AZURE_TENANT_ID --repo "$GH_REPO"
printf '%s' "$AZ_SUBSCRIPTION_ID" | gh secret set AZURE_SUBSCRIPTION_ID --repo "$GH_REPO"
gh variable set APP_MIN_REPLICAS --repo "$GH_REPO" --body "$MIN"
info 'Main-only OIDC configured; Azure IDs stored, no password or long-lived token.'
