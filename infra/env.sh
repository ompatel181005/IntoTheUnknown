# shellcheck shell=bash
# infra/env.sh: sourced by every infra script. Resource names and helpers only, no secrets.
#
# Override with env vars before running a script, e.g.
#   LOC=westus3 SWA_LOC=westus2 bash infra/10-core.sh
# Use the same SUF/LOC/SWA_LOC on every run, or the scripts will look for different resources.

# --- Settings you may override ------------------------------------------------------------
# The ONLY subscription these scripts may touch. The tenant also holds a university-managed
# subscription (UIC-ACCC-WVD) that is not ours; every script aborts unless this one is active.
: "${AZ_SUBSCRIPTION:=Azure for Students}"
# Fixed suffix for globally unique names (storage, ACR, ...). NOT random, so reruns hit the
# same resources. Change it only if 10-core.sh says a name is taken, then keep the new value.
: "${SUF:=itu7q4}"
# Region for everything except the Static Web App. Pick it from 00-preflight.sh output.
: "${LOC:=westus2}"
# Static Web Apps only exist in a few regions; 00-preflight.sh prints a valid, allowed one.
: "${SWA_LOC:=westus2}"
# Monthly budget (USD) for 20-cost-alert.sh.
: "${BUDGET_AMOUNT:=20}"

# --- Names (one place) --------------------------------------------------------------------
RG="rg-planetx"
LAW="log-planetx"                 # Log Analytics workspace
AI="appi-planetx"                 # Application Insights (workspace-based)
SA="stplanetx${SUF}"              # Storage account: 3-24 lowercase letters/digits, global
FRAMES_CONTAINER="frames"         # public blob read
STATE_CONTAINER="state"           # private
ACR="acrplanetx${SUF}"            # Container Registry: 5-50 letters/digits, global
CAE="cae-planetx"                 # Container Apps environment
SWA="swa-planetx"                 # Static Web App (Free)
API="ca-planetx-api"              # Container App: created in #23, not here
FUNC="func-planetx-${SUF}"        # Function app (Flex): created in #24, not here
COSMOS="cosmos-planetx-${SUF}"    # Cosmos DB (free tier): T3 only, not here
BUDGET_NAME="budget-planetx"

# GitHub OIDC (05-oidc-test.sh)
GH_REPO="ompatel181005/IntoTheUnknown"
GH_BRANCH="main"
OIDC_APP_NAME="gh-planetx"
OIDC_CRED_NAME="gh-main"

REQUIRED_PROVIDERS=(
  Microsoft.App
  Microsoft.OperationalInsights
  Microsoft.Insights
  Microsoft.Web
  Microsoft.Storage
  Microsoft.ContainerRegistry
  Microsoft.DocumentDB
)

# --- Shell environment --------------------------------------------------------------------
# Git Bash rewrites arguments that start with "/" into Windows paths, which breaks
# --scope /subscriptions/... and similar. Harmless in Cloud Shell.
export MSYS_NO_PATHCONV=1

# --- Helpers ------------------------------------------------------------------------------
log()  { printf '\n==> %s\n' "$*"; }
info() { printf '    %s\n' "$*"; }
warn() { printf 'WARN: %s\n' "$*" >&2; }
die()  { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

# az.cmd on Windows prints CRLF (the CLI 2.92 Git Bash launcher already prints LF); strip CR
# anyway so captured values compare and concatenate cleanly everywhere.
azq() { az "$@" | tr -d '\r'; }

# True if the command succeeds (used for "show" existence checks). Output is discarded.
exists() { "$@" --only-show-errors >/dev/null 2>&1; }

# Newline-separated set helpers (C collation so sort and comm agree).
norm_regions() { tr '[:upper:]' '[:lower:]' | tr -d ' \r' | sed '/^$/d' | LC_ALL=C sort -u; }
intersect() { LC_ALL=C comm -12 <(printf '%s\n' "$1" | norm_regions) <(printf '%s\n' "$2" | norm_regions); }
in_list() { grep -qxF -- "$1" <<<"$2"; }

# Call plain `az` (the Git Bash launcher in CLI2/wbin, or Cloud Shell's az). Calling az.cmd by
# full path from Git Bash goes through cmd.exe, which mangles the {} and | in --query strings.
require_az() {
  command -v az >/dev/null 2>&1 ||
    die "Azure CLI not found. Install it (winget install -e --id Microsoft.AzureCLI, then open a NEW Git Bash) or use Azure Cloud Shell."
  az account show --only-show-errors >/dev/null 2>&1 || die "Not logged in. Run: az login"
  require_sub
}

# Select $AZ_SUBSCRIPTION and abort unless it really is the active one.
require_sub() {
  az account set --subscription "$AZ_SUBSCRIPTION" --only-show-errors >/dev/null 2>&1 ||
    die "Cannot select subscription \"$AZ_SUBSCRIPTION\". See yours with: az account list -o table"
  local cur
  cur=$(azq account show --query name -o tsv)
  [[ $cur == "$AZ_SUBSCRIPTION" ]] ||
    die "Active subscription is \"$cur\", expected \"$AZ_SUBSCRIPTION\". Aborting before any change."
  printf '==> Subscription: %s\n' "$cur"
}

# --- Sanity checks on overrides -----------------------------------------------------------
if ! [[ $SUF =~ ^[a-z0-9]{3,10}$ ]]; then
  printf 'ERROR: SUF must be 3-10 lowercase letters/digits (got "%s").\n' "$SUF" >&2
  return 1 2>/dev/null || exit 1
fi
for _v in LOC SWA_LOC; do
  if ! [[ ${!_v} =~ ^[a-z0-9]+$ ]]; then
    printf 'ERROR: %s must be a region name like westus2 (got "%s").\n' "$_v" "${!_v}" >&2
    return 1 2>/dev/null || exit 1
  fi
done
unset _v
