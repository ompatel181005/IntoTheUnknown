#!/usr/bin/env bash
# Default is a fully offline plan. --apply is the human's explicit activation.
set -euo pipefail
source "$(dirname "$0")/env.sh"
MODE=${1:---plan}
[[ $MODE == --plan || $MODE == --apply ]] || die 'Usage: 40-watcher.sh [--plan|--apply]'
[[ $MODE != --apply ]] || { [[ ${LOC:-} == westus ]] || die 'Reviewed watcher region is westus.'; require_az; }
export AZ_SUBSCRIPTION_ID AZ_TENANT_ID RG SA API FUNC AI LOC WATCHER_IDENTITY
python "$(native_path "$INFRA_DIR/watcher.py")" "$MODE"
