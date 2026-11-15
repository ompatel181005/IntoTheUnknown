# Watcher activation (#7)

This is a reviewed provisioning/deployment path, not evidence of a live host.
Run it with the human's Student Azure login after the code checks pass. No cloud
resources were changed while preparing this implementation.

The watcher checks collection metadata plus newest frames at the two ecliptic
poles and five pinned targets. It publishes `frames/meta/catalog.json`, keeps its
checkpoint in private `state/watcher.json`, and requests **Live refreshes of the
five pinned API views**. It does not rebuild every one of the 47 catalog points.
An API 202 means a refresh job was accepted; it does not prove frames finished
rendering. Verify job results separately before describing refreshed images.

## Resources and identity

Reuse `rg-planetx`, existing `stplanetxitu7q4` and `appi-planetx`; no new storage,
workspace or Insights account. `watcher.json` creates:

| Resource | Purpose and bounds |
|---|---|
| `id-planetx-watcher` | Dedicated runtime and deployment-storage user identity |
| `plan-planetx-watcher` / `func-planetx-itu7q4` | FC1/Linux/Python 3.11; 2048 MB; max 1 instance; no always-ready instances |
| Private `azure-webjobs-hosts`, `azure-webjobs-secrets` containers | Timer leases/locks and Function access-key storage; Blob Data Owner scoped to these two containers |
| Private `watcher-packages` | Flex deployment content; Blob Data Contributor scoped to this container |
| Existing `state` and `frames` | Blob Data Contributor for private checkpoints and public metadata; no account-wide data grant |
| Existing `id-planetx-github` | Website Contributor scoped only to this Function app for code deployment; no role-assignment or storage grant |

Blob Data Owner is a **data role**, not ARM Owner. The host containers are
precreated to permit narrow container scopes. Host startup and timer execution
must still be verified live; do not widen permissions automatically after an
error. The storage preflight refuses `allowSharedKeyAccess` other than `false`.
Host settings use `AzureWebJobsStorage__accountName`, `__credential=managedidentity`
and `__clientId`; `AZURE_CLIENT_ID` selects the same identity for the watcher SDK.
Flex deployment storage also explicitly selects that user identity.

## Human execution

Requirements: Python 3.11+, Git, Azure CLI supporting Flex OneDeploy, and a login
with resource provisioning plus scoped role-assignment permissions. Existing
main-only OIDC identity setup (`06-ci-identity.sh`) must already be complete.
No `func` installation, shared storage key or publish profile is needed.

From the reviewed checkout, Git Bash example (the IDs file remains ignored):

```bash
AZ_ENV_LOCAL=/d/NasaSpacehacks2026/infra/.env.local LOC=westus bash infra/40-watcher.sh --plan
# Only after reviewing that plan:
AZ_ENV_LOCAL=/d/NasaSpacehacks2026/infra/.env.local LOC=westus bash infra/40-watcher.sh --apply
```

`--plan` is fully offline. `--apply` verifies explicit subscription GUID, tenant
GUID **and** `Azure for Students` name, and is limited to reviewed `westus`.
It reads the existing API/Insights/storage configuration, wires the API secret,
deploys ARM incrementally, then deploys a ZIP containing **committed** Functions
runtime files at its root. Ignored local settings, tests, local dependencies and
uncommitted files are excluded. `config-zip --build-remote true` invokes Flex
OneDeploy and a remote Linux dependency build. Only package hash/status is logged;
cloud error bodies are withheld because they can contain settings. Inspect
deployment operations securely in Azure if a step fails. Role propagation can
take time; a rerun reuses the same identity/roles/key rather than rotating it.

The helper retrieves the CLI ARM bearer token in memory. A 48-byte random
`REFRESH_KEY` is initialized only for an unwired API bootstrap; reruns recover and
compare the existing encrypted Container App secret. The API gets a secretRef,
the watcher gets the same app-setting value, and ARM parameters are secureString.
No key/token is printed, put in command arguments, or written to a parameter
file. A named-but-withheld key, dangling existing REFRESH_KEY, or API/watcher key
disagreement causes refusal. There is no automatic secret rotation.

`30-app.sh` full ARM deployments now preserve the refresh key through the same
in-memory client. A new/unwired app can bootstrap securely, avoiding a circular
dependency on watcher activation. The ordinary image-only main workflow preserves
existing secrets/settings. The watcher API PATCH explicitly preserves the
standard Consumption environment IDs and profile as well as the current image,
scale, unrelated environment entries and other secrets.

## Verification and subsequent code updates

After applying, verify the host indexed `new_data_watcher` and `run_now`, the daily schedule
and no startup invocation, private host/package containers, identity RBAC and
Application Insights host logs. Invoke the authenticated run-now endpoint only
with a function key kept in memory/a header; never paste it into a URL/log. Check
the checkpoint/public metadata version and the API's refresh response, then poll
accepted jobs to establish actual render completion. Also verify normal saved
presets remain usable without an archive request. These are live gates, not
claims established by offline tests.

`deploy-watcher.yml` tests and remotely deploys committed Functions code on main
pushes touching `functions/**`, its packaging helper or the workflow itself, and
supports manual main dispatch. It reuses GitHub OIDC and app-scoped Website
Contributor; provisioning/RBAC/secret changes remain human-run. Initial activation
must precede the first workflow deployment. Manual `40-watcher.sh --apply` remains
a rerunnable provisioning/code-deployment recovery path.

## References checked 2026-11-15

- [Flex management/deployment](https://learn.microsoft.com/en-us/azure/azure-functions/flex-consumption-how-to): explicit `config-zip --build-remote true`.
- [Python builds](https://learn.microsoft.com/en-us/azure/azure-functions/python-build-options) and [deployment technologies](https://learn.microsoft.com/en-us/azure/azure-functions/functions-deployment-technologies): Flex uses OneDeploy and its configured Blob container.
- [Identity connections](https://learn.microsoft.com/en-us/azure/azure-functions/manage-connections?tabs=host,identity) and the [official ARM sample](https://github.com/Azure-Samples/azure-functions-flex-consumption-samples/blob/main/IaC/armtemplate/azuredeploy.json): MI host/deployment storage, Blob Data Owner for host storage.
- [Current migration guidance](https://learn.microsoft.com/en-us/azure/azure-functions/migration/migrate-plan-consumption-to-flex): scale limit 1–1000; HTTP limits below 40 may throttle. An older ARM quickstart still sets minValue 40. This low-frequency timer deliberately sets 1; live provider validation is required.
- [Website Contributor](https://learn.microsoft.com/en-us/azure/role-based-access-control/built-in-roles/web-and-mobile#website-contributor): app management without granting RBAC assignment rights.

CLI help was checked locally for `config-zip --build-remote`, timeout, and Flex
creation instance settings. Help used an isolated temporary Azure config without
accessing the human's credentials.
