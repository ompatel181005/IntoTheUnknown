#!/usr/bin/env bash
# Combined React + FastAPI deployment. Default: print a plan, with no cloud calls.
# After review and core provisioning: SOURCE_REF=origin/main bash infra/30-app.sh --apply
set -euo pipefail
source "$(dirname "$0")/env.sh"
cd "$INFRA_DIR/.."
MODE=${1:---plan}
[[ $MODE == --plan || $MODE == --apply || $MODE == --deploy-only ]] || die 'Usage: 30-app.sh [--plan|--apply|--deploy-only]'
MIN_REPLICAS=${MIN_REPLICAS:-0}
[[ $MIN_REPLICAS == 0 || $MIN_REPLICAS == 1 ]] || die 'MIN_REPLICAS must be 0 or 1.'
SOURCE_REF=${SOURCE_REF:-origin/main}
SOURCE_SHA=$(git rev-parse --verify "${SOURCE_REF}^{commit}")
TAG=${SOURCE_SHA:0:12}
IMAGE="$ACR.azurecr.io/spherex-blink:$TAG"
BUILD_LINE='ACR remote Linux/amd64 build from git archive (tracked files only)'
[[ $MODE != --deploy-only ]] || BUILD_LINE='Use an existing, digest-verified image; skip ACR Tasks'
cat <<EOF
Source commit: $SOURCE_SHA
Build: $BUILD_LINE
Image: $IMAGE
Target: $RG / $CAE / $API
App: one React + FastAPI container, port 8000, 1 vCPU / 2 GiB
Scale: $MIN_REPLICAS minimum / 1 maximum (jobs currently live in one process)
Identity: dedicated user-assigned; AcrPull on $ACR, Blob Data Contributor on $SA
Cache: local ephemeral files; golden snapshots are bundled in the image
Watcher, Blob-backed render cache and Application Insights SDK wiring remain separate work.
EOF
[[ $MODE != --plan ]] || exit 0

require_az
exists azs group show -n "$RG" || die 'Run reviewed 10-core.sh first: project resource group is absent.'
exists azs acr show -g "$RG" -n "$ACR" || die 'Project registry is absent.'
exists azs containerapp env show -g "$RG" -n "$CAE" || die 'Project Container Apps environment is absent.'
ARM_AUTH=$(azsq acr config authentication-as-arm show -r "$ACR" --query status -o tsv)
[[ $ARM_AUTH == enabled ]] || die 'ACR ARM-token authentication must be enabled for managed-identity pulls; review registry configuration first.'
git cat-file -e "$SOURCE_SHA:.dockerignore" || die 'Selected source must contain the reviewed .dockerignore.'
git cat-file -e "$SOURCE_SHA:frontend/public/golden/barnard/manifest.json" || die 'Selected source must include the reviewed golden snapshots.'

if [[ $MODE == --apply ]]; then
# git archive excludes all ignored/untracked files. Keep the archive outside the upload folder.
STAGING=$(mktemp -d)
trap 'rm -f "$STAGING/source.tar"' EXIT
git archive --format=tar --output="$(native_path "$STAGING/source.tar")" "$SOURCE_SHA"
mkdir "$STAGING/context"
tar -xf "$STAGING/source.tar" -C "$STAGING/context"
info "Build context: $STAGING/context (retained locally for inspection; contains tracked source only)"
RUN_ID=$(azsq acr build --registry "$ACR" --image "spherex-blink:$TAG" --file Dockerfile \
  --platform linux/amd64 "$(native_path "$STAGING/context")" --no-logs --query runId -o tsv)
[[ -n $RUN_ID ]] || die 'ACR did not return a build run ID.'
DEADLINE=$((SECONDS + 900))
while :; do
  BUILD_STATUS=$(azsq acr task show-run -r "$ACR" --run-id "$RUN_ID" --query status -o tsv)
  case $BUILD_STATUS in
    Succeeded) break ;;
    Queued|Started|Running) ;;
    *) die "ACR build $RUN_ID ended with status $BUILD_STATUS; no app update attempted." ;;
  esac
  (( SECONDS < DEADLINE )) || die "Timed out waiting for ACR build $RUN_ID; no app update attempted."
  sleep 5
done
else
  DIGEST=$(azsq acr repository show -n "$ACR" --image "spherex-blink:$TAG" --query digest -o tsv) ||
    die 'The selected image is absent. Build it with the approved GitHub workflow first.'
  [[ $DIGEST =~ ^sha256:[0-9a-f]{64}$ ]] || die 'Registry returned an invalid image digest; no app update attempted.'
  info "Using existing image $IMAGE ($DIGEST); no ACR Tasks build requested."
fi

if ! exists azs identity show -g "$RG" -n "$APP_IDENTITY"; then
  LOCATION=$(azsq containerapp env show -g "$RG" -n "$CAE" --query location -o tsv | norm_regions)
  azs identity create -g "$RG" -n "$APP_IDENTITY" -l "$LOCATION" -o none
fi
IDENTITY_ID=$(azsq identity show -g "$RG" -n "$APP_IDENTITY" --query id -o tsv)
CLIENT_ID=$(azsq identity show -g "$RG" -n "$APP_IDENTITY" --query clientId -o tsv)
PRINCIPAL=$(azsq identity show -g "$RG" -n "$APP_IDENTITY" --query principalId -o tsv)
ACR_ID=$(azsq acr show -g "$RG" -n "$ACR" --query id -o tsv)
STORAGE_ID=$(azsq storage account show -g "$RG" -n "$SA" --query id -o tsv)
ENV_ID=$(azsq containerapp env show -g "$RG" -n "$CAE" --query id -o tsv)
[[ -n $IDENTITY_ID && -n $CLIENT_ID && -n $PRINCIPAL && -n $ACR_ID && -n $STORAGE_ID && -n $ENV_ID ]] || die 'Missing app identity or core resource IDs.'
for spec in "AcrPull|$ACR_ID" "Storage Blob Data Contributor|$STORAGE_ID"; do
  role=${spec%%|*}; scope=${spec#*|}
  HAVE=$(azsq role assignment list --assignee-object-id "$PRINCIPAL" --role "$role" --scope "$scope" --fill-principal-name false --query 'length(@)' -o tsv)
  if [[ $HAVE -eq 0 ]]; then
    azs role assignment create --assignee-object-id "$PRINCIPAL" --assignee-principal-type ServicePrincipal \
      --role "$role" --scope "$scope" -o none
  fi
done
# Full ARM create/update preserves the explicit environment. Live CLI PATCH updates failed
# with ExpressSystemAssignedIdentityNotSupported; the dedicated user identity works for both paths.
LOCATION=$(azsq containerapp env show -g "$RG" -n "$CAE" --query location -o tsv | norm_regions)
azs deployment group create -g "$RG" --name core-app \
  --template-file "$(native_path "$INFRA_DIR/containerapp.json")" \
  --parameters "appName=$API" "location=$LOCATION" "environmentId=$ENV_ID" \
    "identityResourceId=$IDENTITY_ID" "identityClientId=$CLIENT_ID" \
    "image=$IMAGE" "registryServer=$ACR.azurecr.io" "storageAccountUrl=https://$SA.blob.core.windows.net" \
    "framesContainer=$FRAMES_CONTAINER" "stateContainer=$STATE_CONTAINER" "minReplicas=$MIN_REPLICAS" \
    "applicationInsightsName=$AI" -o none
HOST=$(azsq containerapp show -g "$RG" -n "$API" --query properties.configuration.ingress.fqdn -o tsv)
[[ -n $HOST ]] || die 'Deployment returned no public hostname.'
info "Public app: https://$HOST"
curl --fail --silent --show-error --retry 6 --retry-delay 10 --retry-all-errors --max-time 90 "https://$HOST/api/health"
printf '\nCheck all five saved presets at https://%s before calling deployment verified.\n' "$HOST"
