# shellcheck shell=bash
# infra/env.sh: sourced by every infra script. Names and helpers only, no secrets, no IDs.
#
# IDs live in infra/.env.local (git-ignored, never committed):
#   AZ_SUBSCRIPTION_ID=<guid>   AZ_TENANT_ID=<guid>   (required; the "Azure for Students" IDs)
#   AZ_OIDC_APP_ID=<guid>       (written by 05-oidc-test.sh)
# Exported env vars win over the file. Example:
#   LOC=westus bash infra/10-core.sh

INFRA_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ENV_LOCAL_DEFAULT="$INFRA_DIR/.env.local"
ENV_LOCAL="${AZ_ENV_LOCAL:-$ENV_LOCAL_DEFAULT}"   # AZ_ENV_LOCAL: only for offline tests

# --- Settings ---------------------------------------------------------------------------
# The only subscription these scripts may touch. The tenant also holds the university-managed
# "UIC-ACCC-WVD"; require_sub aborts unless id, tenant and name all match.
AZ_SUBSCRIPTION_NAME="Azure for Students"
# Fixed suffix for globally unique names. NOT random, so reruns hit the same resources.
# Change it only if 10-core.sh says a name is taken, then keep the new value.
: "${SUF:=itu7q4}"
# LOC has no default: 10-core.sh refuses to run until you export it (from 00-preflight.sh, or
# chosen by hand after checking Policy > Assignments in the portal).
# SWA_LOC is optional. The combined container is the default frontend host.
# Set FRONTEND_HOST=swa and a region only if the current policy allows it.
: "${SWA_LOC:=none}"
# The integrated app is one Container App. Blob/SWA hosting remain explicit alternatives.
: "${FRONTEND_HOST:=container}"
[[ $FRONTEND_HOST == container || $FRONTEND_HOST == blob || $FRONTEND_HOST == swa ]] ||
  { printf 'ERROR: FRONTEND_HOST must be container, blob or swa.\n' >&2; return 1 2>/dev/null || exit 1; }
[[ $FRONTEND_HOST != swa || $SWA_LOC != none ]] ||
  { printf 'ERROR: SWA_LOC is required for FRONTEND_HOST=swa.\n' >&2; return 1 2>/dev/null || exit 1; }
# Monthly budget (USD) for 20-cost-alert.sh.
: "${BUDGET_AMOUNT:=20}"

# --- Names (one place) ------------------------------------------------------------------
RG="rg-planetx"
LAW="log-planetx"                 # Log Analytics workspace
AI="appi-planetx"                 # Application Insights (workspace-based)
SA="stplanetx${SUF}"              # Storage account: 3-24 lowercase letters/digits, global
FRAMES_CONTAINER="frames"         # public blob read
STATE_CONTAINER="state"           # private
ACR="acrplanetx${SUF}"            # Container Registry: 5-50 letters/digits, global
CAE="cae-planetx"                 # Container Apps environment
SWA="swa-planetx"                 # Static Web App (Free): only if SWA_LOC is a region
WEB_INDEX="index.html"            # Blob static website ($web container) index and 404 page
API="ca-planetx-api"              # Container App: created in #23, not here
APP_IDENTITY="id-planetx-api"     # Dedicated user-assigned identity for runtime and registry pulls
FUNC="func-planetx-${SUF}"        # Function app (Flex): created in #24, not here
COSMOS="cosmos-planetx-${SUF}"    # Cosmos DB (free tier): T3 only, not here
BUDGET_NAME="budget-planetx"

# GitHub OIDC (05-oidc-test.sh)
GH_REPO="ompatel181005/IntoTheUnknown"
GH_BRANCH="main"
OIDC_APP_NAME="gh-planetx-${SUF}"
OIDC_CRED_NAME="gh-main"

REQUIRED_PROVIDERS=(
  Microsoft.App
  Microsoft.OperationalInsights
  Microsoft.Insights
  Microsoft.Web
  Microsoft.Storage
  Microsoft.ContainerRegistry
  Microsoft.ManagedIdentity
  Microsoft.DocumentDB
)

# Region policy lookup (00-preflight.sh, 10-core.sh).
# atScope() = every assignment that applies at subscription scope, including ones inherited from
# management groups. The CLI default sends atExactScope() and --disable-scope-strict-match sends
# atScopeAndBelow(); both can miss an inherited region policy.
POLICY_FILTER="atScope()"
ALLOWED_LOC_DEF="e56962a6-4747-49cd-b67b-bf8b01975c4c"   # built-in "Allowed locations"
LOCQ="[?contains(displayName || '', 'region') || contains(displayName || '', 'Region') || contains(displayName || '', 'location') || contains(displayName || '', 'Location') || ends_with(policyDefinitionId || '', '${ALLOWED_LOC_DEF}')]"

GUID_RE='^[0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$'

# --- Shell environment ------------------------------------------------------------------
# Git Bash rewrites arguments that start with "/" into Windows paths (--scope /subscriptions/...).
export MSYS_NO_PATHCONV=1

# --- Helpers ----------------------------------------------------------------------------
log()  { printf '\n==> %s\n' "$*"; }
info() { printf '    %s\n' "$*"; }
warn() { printf 'WARN: %s\n' "$*" >&2; }
die()  { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
# Portable lowercase: macOS ships bash 3.2, which has no ${x,,}.
lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }

# az.cmd on Windows prints CRLF (the CLI 2.92 Git Bash launcher prints LF); strip CR anyway.
azq() { az "$@" | tr -d '\r'; }
# Subscription-scoped az: ALWAYS pinned to $AZ_SUBSCRIPTION_ID, never the CLI default.
# Use these for group/storage/acr/monitor/containerapp/staticwebapp/provider/policy/cosmosdb/
# role/functionapp. infra/check-scripts.sh fails if a script calls those without --subscription.
azs()  { az "$@" --subscription "$AZ_SUBSCRIPTION_ID"; }
azsq() { azs "$@" | tr -d '\r'; }

# Explicit ARM resource IDs must not be MSYS-converted, but file paths must be native for az.
native_path() {
  if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else printf '%s\n' "$1"; fi
}

# True if the command succeeds (existence checks). Output is discarded.
exists() { "$@" --only-show-errors >/dev/null 2>&1; }

# Newline-separated set helpers (C collation so sort and comm agree). Region names are
# normalised: "West US 3" -> westus3.
norm_regions() { tr '[:upper:]' '[:lower:]' | tr -d ' \r' | sed '/^$/d' | LC_ALL=C sort -u; }
intersect() { LC_ALL=C comm -12 <(printf '%s\n' "$1" | norm_regions) <(printf '%s\n' "$2" | norm_regions); }
in_list() { grep -qxF -- "$1" <<<"$2"; }

# Read infra/.env.local: only the known keys, KEY=VALUE, no shell evaluation.
load_env_local() {
  local key val
  [[ -f $ENV_LOCAL ]] || return 0
  while IFS='=' read -r key val || [[ -n $key ]]; do
    key=${key//[[:space:]]/}
    val=${val//[[:space:]]/}
    case $key in
      AZ_SUBSCRIPTION_ID | AZ_TENANT_ID | AZ_OIDC_APP_ID)
        if [[ -z ${!key:-} ]]; then printf -v "$key" '%s' "$val"; fi
        ;;
    esac
  done <"$ENV_LOCAL"
  return 0
}

# Write or replace one KEY=VALUE line in infra/.env.local, after checking git ignores it.
set_env_local() {
  local tmp
  if [[ $ENV_LOCAL == "$ENV_LOCAL_DEFAULT" ]] && git -C "$INFRA_DIR" rev-parse --git-dir >/dev/null 2>&1; then
    git -C "$INFRA_DIR" check-ignore -q "$ENV_LOCAL" ||
      die "$ENV_LOCAL is not git-ignored; refusing to write IDs into it."
  fi
  tmp=$(mktemp)
  {
    if [[ -f $ENV_LOCAL ]]; then grep -v "^$1=" "$ENV_LOCAL" || true; fi
    printf '%s=%s\n' "$1" "$2"
  } >"$tmp"
  mv "$tmp" "$ENV_LOCAL"
}

# Call plain `az` (the Git Bash launcher in CLI2/wbin, or Cloud Shell's az). Calling az.cmd by
# full path from Git Bash goes through cmd.exe, which mangles {} and | in --query strings.
require_az() {
  command -v az >/dev/null 2>&1 ||
    die "Azure CLI not found. Install it (winget install -e --id Microsoft.AzureCLI, then open a NEW Git Bash) or use Azure Cloud Shell."
  az account show --only-show-errors >/dev/null 2>&1 || die "Not logged in. Run: az login"
  require_sub
}

# Verify $AZ_SUBSCRIPTION_ID by id, tenant and name, then make it the CLI default as well
# (so commands pasted from infra/README.md hit it too). Every az call still pins it explicitly.
require_sub() {
  local got id tenant name
  [[ ${AZ_SUBSCRIPTION_ID:-} =~ $GUID_RE ]] ||
    die "AZ_SUBSCRIPTION_ID is not set. Put AZ_SUBSCRIPTION_ID=<guid> in infra/.env.local (git-ignored) or export it."
  [[ ${AZ_TENANT_ID:-} =~ $GUID_RE ]] ||
    die "AZ_TENANT_ID is not set. Put AZ_TENANT_ID=<guid> in infra/.env.local (git-ignored) or export it."
  got=$(azq account show --subscription "$AZ_SUBSCRIPTION_ID" --query "[id, tenantId, name]" -o tsv 2>/dev/null) ||
    die "Subscription $AZ_SUBSCRIPTION_ID is not visible to the signed-in account. Run: az login --tenant $AZ_TENANT_ID"
  { read -r id || true; read -r tenant || true; read -r name || true; } <<<"$got"
  [[ $(lower "$id") == "$(lower "$AZ_SUBSCRIPTION_ID")" ]] || die "az returned subscription \"$id\", expected $AZ_SUBSCRIPTION_ID. Aborting."
  [[ $(lower "$tenant") == "$(lower "$AZ_TENANT_ID")" ]] || die "Subscription is in tenant \"$tenant\", expected $AZ_TENANT_ID. Aborting."
  [[ $name == "$AZ_SUBSCRIPTION_NAME" ]] || die "Subscription name is \"$name\", expected \"$AZ_SUBSCRIPTION_NAME\". Aborting."
  az account set --subscription "$AZ_SUBSCRIPTION_ID" --only-show-errors >/dev/null
  printf '==> Subscription: %s (id and tenant match infra/.env.local)\n' "$name"
}

# Sets ALLOWED (newline list) and POLICY_STATE:
#   ok         every location-type assignment yielded a region list (ALLOWED = intersection)
#   none       no location-type assignment is visible
#   unreadable listing failed, or some assignment's region list could not be parsed
# Optional $1 = resource group: list what applies at that RG's scope. Policies assigned to the
# RG itself are only visible once the RG exists, so 10-core.sh checks again right after creating it.
read_allowed_regions() {
  local n raw line list got=0
  local scope=()
  if [[ -n ${1:-} ]]; then scope=(--resource-group "$1"); fi
  ALLOWED=""
  POLICY_STATE="unreadable"
  n=$(azsq policy assignment list ${scope[@]+"${scope[@]}"} --filter "$POLICY_FILTER" --query "length(${LOCQ})" -o tsv 2>/dev/null) ||
    return 0
  [[ $n =~ ^[0-9]+$ ]] || return 0
  if [[ $n -eq 0 ]]; then
    POLICY_STATE="none"
    return 0
  fi
  raw=$(azsq policy assignment list ${scope[@]+"${scope[@]}"} --filter "$POLICY_FILTER" \
    --query "${LOCQ}.join(',', parameters.listOfAllowedLocations.value || parameters.allowedLocations.value || \`[]\`)" \
    -o tsv 2>/dev/null) || return 0
  while IFS= read -r line; do
    [[ -z $line ]] && continue
    list=$(tr ',' '\n' <<<"$line" | norm_regions)
    if [[ $got -eq 0 ]]; then ALLOWED=$list; else ALLOWED=$(intersect "$ALLOWED" "$list"); fi
    got=$((got + 1))
  done <<<"$raw"
  if [[ $got -eq $n ]]; then POLICY_STATE="ok"; else ALLOWED=""; fi
  return 0
}

load_env_local

# --- Sanity checks on overrides ---------------------------------------------------------
if ! [[ $SUF =~ ^[a-z0-9]{3,10}$ ]]; then
  printf 'ERROR: SUF must be 3-10 lowercase letters/digits (got "%s").\n' "$SUF" >&2
  return 1 2>/dev/null || exit 1
fi
for _v in LOC SWA_LOC; do
  if [[ -n ${!_v:-} && ! ${!_v} =~ ^[a-z0-9]+$ ]]; then
    printf 'ERROR: %s must be a region name like westus2 (got "%s").\n' "$_v" "${!_v}" >&2
    return 1 2>/dev/null || exit 1
  fi
done
unset _v
