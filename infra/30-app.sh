#!/usr/bin/env bash
# Combined React + FastAPI deployment. Default: print a plan, with no cloud calls.
# After review and core provisioning: SOURCE_REF=origin/main bash infra/30-app.sh --apply
set -euo pipefail
source "$(dirname "$0")/env.sh"
cd "$INFRA_DIR/.."
[[ ${1:---plan} == --plan || ${1:-} == --apply ]] || die 'Usage: 30-app.sh [--plan|--apply]'
SOURCE_REF=${SOURCE_REF:-origin/main}
SOURCE_SHA=$(git rev-parse --verify "${SOURCE_REF}^{commit}")
TAG=${SOURCE_SHA:0:12}
IMAGE="$ACR.azurecr.io/spherex-blink:$TAG"
cat <<EOF
Source commit: $SOURCE_SHA
Build: ACR remote Linux/amd64 build from git archive (tracked files only)
Image: $IMAGE
Target: $RG / $CAE / $API
App: one React + FastAPI container, port 8000, 1 vCPU / 2 GiB
Scale: 0 minimum / 1 maximum (jobs currently live in one process)
Identity: system-assigned, AcrPull on $ACR only
Cache: local ephemeral files; golden snapshots are bundled in the image
Watcher, Blob-backed render cache and Application Insights SDK wiring remain separate work.
EOF
[[ ${1:---plan} == --apply ]] || exit 0

require_az
exists azs group show -n "$RG" || die 'Run reviewed 10-core.sh first: project resource group is absent.'
exists azs acr show -g "$RG" -n "$ACR" || die 'Project registry is absent.'
exists azs containerapp env show -g "$RG" -n "$CAE" || die 'Project Container Apps environment is absent.'
ARM_AUTH=$(azsq acr config authentication-as-arm show -r "$ACR" --query status -o tsv)
[[ $ARM_AUTH == enabled ]] || die 'ACR ARM-token authentication must be enabled for managed-identity pulls; review registry configuration first.'
git cat-file -e "$SOURCE_SHA:.dockerignore" || die 'Selected source must contain the reviewed .dockerignore.'
git cat-file -e "$SOURCE_SHA:frontend/public/golden/barnard/manifest.json" || die 'Selected source must include the reviewed golden snapshots.'

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

if ! exists azs containerapp show -g "$RG" -n "$API"; then
  # Bootstrap the system identity with a public image before granting registry access.
  azs containerapp create -g "$RG" -n "$API" --environment "$CAE" \
    --image mcr.microsoft.com/k8se/quickstart:latest \
    --cpu 0.5 --memory 1.0Gi --min-replicas 0 --max-replicas 1 --system-assigned -o none
fi
azs containerapp identity assign -g "$RG" -n "$API" --system-assigned -o none
PRINCIPAL=$(azsq containerapp identity show -g "$RG" -n "$API" --query principalId -o tsv)
ACR_ID=$(azsq acr show -g "$RG" -n "$ACR" --query id -o tsv)
[[ -n $PRINCIPAL && -n $ACR_ID ]] || die 'Missing app principal or registry resource ID.'
HAVE=$(azsq role assignment list --assignee-object-id "$PRINCIPAL" --role AcrPull --scope "$ACR_ID" --fill-principal-name false --query 'length(@)' -o tsv)
if [[ $HAVE -eq 0 ]]; then
  azs role assignment create --assignee-object-id "$PRINCIPAL" --assignee-principal-type ServicePrincipal \
    --role AcrPull --scope "$ACR_ID" -o none
fi
azs containerapp registry set -g "$RG" -n "$API" --server "$ACR.azurecr.io" --identity system -o none
# RBAC propagation may take a few minutes. Re-running with the same SHA is safe if pulling fails.
azs containerapp update -g "$RG" -n "$API" --image "$IMAGE" --cpu 1.0 --memory 2.0Gi \
  --min-replicas 0 --max-replicas 1 -o none
azs containerapp ingress enable -g "$RG" -n "$API" --type external --target-port 8000 -o none
HOST=$(azsq containerapp show -g "$RG" -n "$API" --query properties.configuration.ingress.fqdn -o tsv)
[[ -n $HOST ]] || die 'Deployment returned no public hostname.'
info "Public app: https://$HOST"
curl --fail --silent --show-error --retry 6 --retry-delay 10 --retry-all-errors --max-time 90 "https://$HOST/api/health"
printf '\nCheck all five saved presets at https://%s before calling deployment verified.\n' "$HOST"
