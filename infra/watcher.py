"""Guarded watcher activation. Plan is offline; only explicit --apply mutates Azure."""

from __future__ import annotations

import argparse
import copy
import hashlib
import os
import secrets
import stat
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

from azure_arm import APP_API, Arm, DeploymentError, refresh_secret

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
WEB_API = "2024-04-01"


def package_functions(destination: Path) -> str:
    """Only committed Functions runtime files, flattened to the zip project root."""
    files = subprocess.run(
        ["git", "ls-tree", "-r", "--name-only", "HEAD", "functions/"],
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.splitlines()
    allowed = [
        name
        for name in files
        if (
            name in ("functions/host.json", "functions/requirements.txt")
            or (
                name.startswith("functions/")
                and "/tests/" not in name
                and name.endswith(".py")
            )
        )
    ]
    if not {
        "functions/host.json",
        "functions/requirements.txt",
        "functions/function_app.py",
    }.issubset(allowed):
        raise DeploymentError("Committed Functions package is incomplete.")
    with zipfile.ZipFile(destination, "w", zipfile.ZIP_DEFLATED) as archive:
        for name in allowed:
            content = subprocess.run(
                ["git", "show", f"HEAD:{name}"],
                cwd=ROOT,
                check=True,
                capture_output=True,
            ).stdout
            # writestr defaults to 0600. Flex extracts as a different runtime user,
            # which must be able to read host.json and the Python entry point.
            info = zipfile.ZipInfo(name.removeprefix("functions/"))
            info.create_system = 3
            info.external_attr = (stat.S_IFREG | 0o644) << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, content)
    return hashlib.sha256(destination.read_bytes()).hexdigest()


def wire_api_secret(arm: Arm, app_id: str, app: dict, secret: str):
    """Preserve every existing CA secret and environment entry; wire one shared key."""
    listed = arm.request("POST", app_id + f"/listSecrets?api-version={APP_API}", {})
    entries = listed.get("value", [])
    for entry in entries:
        if not entry.get("keyVaultUrl") and not entry.get("value"):
            raise DeploymentError(
                "A Container App secret value was withheld; refusing to replace secrets."
            )
    entries = [entry for entry in entries if entry.get("name") != "refresh-key"]
    entries.append({"name": "refresh-key", "value": secret})
    template = copy.deepcopy(app["properties"]["template"])
    containers = template.get("containers", [])
    if len(containers) != 1:
        raise DeploymentError(
            "Expected one API container; review the deployment before activation."
        )
    env = [
        item
        for item in containers[0].get("env", [])
        if item.get("name") != "REFRESH_KEY"
    ]
    for item in containers[0].get("env", []):
        if item.get("name") == "REFRESH_KEY" and item.get("secretRef") != "refresh-key":
            raise DeploymentError(
                "Unexpected REFRESH_KEY wiring; refusing automatic replacement."
            )
    env.append({"name": "REFRESH_KEY", "secretRef": "refresh-key"})
    containers[0]["env"] = env
    properties = app["properties"]
    environment = properties.get("environmentId") or properties.get(
        "managedEnvironmentId"
    )
    if not environment or properties.get("workloadProfileName") != "Consumption":
        raise DeploymentError("Expected the explicit standard Consumption environment.")
    arm.request(
        "PATCH",
        app_id + f"?api-version={APP_API}",
        {
            "location": app["location"],
            "identity": {
                "type": "UserAssigned",
                "userAssignedIdentities": {
                    key: {}
                    for key in app.get("identity", {}).get("userAssignedIdentities", {})
                },
            },
            "properties": {
                "environmentId": environment,
                "managedEnvironmentId": environment,
                "workloadProfileName": "Consumption",
                "configuration": {"secrets": entries},
                "template": template,
            },
        },
    )


def activate(
    arm: Arm,
    *,
    location: str,
    group: str,
    storage: str,
    app_name: str,
    function: str,
    insights: str,
    identity: str,
):
    if location != "westus":
        raise DeploymentError("This reviewed activation is limited to westus.")
    storage_id = arm.resource(group, "Microsoft.Storage/storageAccounts", storage)
    stored = arm.request("GET", storage_id + "?api-version=2023-05-01")
    if stored["properties"].get("allowSharedKeyAccess") is not False:
        raise DeploymentError(
            "Existing storage must have allowSharedKeyAccess=false; no shared keys are used."
        )
    arm.request(
        "GET",
        arm.resource(group, "Microsoft.Insights/components", insights)
        + "?api-version=2020-02-02",
    )
    arm.request(
        "GET",
        arm.resource(
            group,
            "Microsoft.ManagedIdentity/userAssignedIdentities",
            "id-planetx-github",
        )
        + "?api-version=2023-01-31",
    )
    app_id = arm.resource(group, "Microsoft.App/containerApps", app_name)
    app = arm.request("GET", app_id + f"?api-version={APP_API}")
    identities = app.get("identity", {}).get("userAssignedIdentities", {})
    if len(identities) != 1 or app.get("identity", {}).get("type") != "UserAssigned":
        raise DeploymentError("Expected the reviewed dedicated API user identity.")
    hostname = app["properties"]["configuration"]["ingress"]["fqdn"]
    if not hostname.endswith(".azurecontainerapps.io"):
        raise DeploymentError("Unexpected API hostname.")
    function_id = arm.resource(group, "Microsoft.Web/sites", function)
    current = arm.request(
        "GET", function_id + f"?api-version={WEB_API}", missing_ok=True
    )
    old_secret = refresh_secret(arm, app_id)
    if current:
        settings = arm.request(
            "POST", function_id + f"/config/appsettings/list?api-version={WEB_API}", {}
        )
        configured = settings.get("properties", {}).get("REFRESH_KEY")
        if configured and (
            old_secret is None or not secrets.compare_digest(configured, old_secret)
        ):
            raise DeploymentError(
                "Watcher/API refresh secrets differ; refusing automatic rotation."
            )
    if old_secret is None and any(
        entry.get("name") == "REFRESH_KEY"
        for container in app["properties"].get("template", {}).get("containers", [])
        for entry in container.get("env", [])
    ):
        raise DeploymentError(
            "REFRESH_KEY is already wired but its secret is absent; refusing replacement."
        )
    secret = old_secret or secrets.token_urlsafe(48)
    # First wire the API. On a partial failure the rerun recovers the same key from it.
    wire_api_secret(arm, app_id, app, secret)
    arm.deploy(
        group,
        "watcher-activation",
        HERE / "watcher.json",
        {
            "location": location,
            "functionName": function,
            "planName": "plan-planetx-watcher",
            "identityName": identity,
            "storageAccountName": storage,
            "applicationInsightsName": insights,
            "apiBase": "https://" + hostname,
            "refreshKey": secret,
        },
    )
    # Remote Linux build/OneDeploy: do not upload local dependencies or settings.
    with tempfile.TemporaryDirectory(prefix="planetx-functions-") as folder:
        package = Path(folder) / "watcher.zip"
        digest = package_functions(package)
        print("Deploying committed Functions package SHA256=" + digest)
        result = subprocess.run(
            [
                os.environ.get("AZ_CLI", "az.cmd" if os.name == "nt" else "az"),
                "functionapp",
                "deployment",
                "source",
                "config-zip",
                "--subscription",
                arm.subscription,
                "--resource-group",
                group,
                "--name",
                function,
                "--src",
                str(package),
                "--build-remote",
                "true",
                "--timeout",
                "600",
                "--only-show-errors",
                "-o",
                "none",
            ],
            capture_output=True,
            check=False,
        )
        if result.returncode:
            raise DeploymentError(
                "OneDeploy/remote build failed; inspect Azure deployment logs securely and rerun."
            )
    print(
        "Watcher provisioned and package deployed. Verify indexed timer/run-now and host health in Azure."
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--plan", action="store_true")
    args = parser.parse_args()
    if not args.apply:
        print(
            "PLAN ONLY: reuse project storage/Insights; dedicated id-planetx-watcher; Flex FC1 Python3.11, "
            "2048 MB, max2, no always-ready. Private host/package containers, container-scoped Blob RBAC; "
            "MI host/deployment storage. Preserve or securely generate one refresh key in memory, "
            "wire API and watcher; OneDeploy tracked code with remote Linux build. No Azure calls."
        )
        return
    arm = Arm(os.environ["AZ_SUBSCRIPTION_ID"], os.environ["AZ_TENANT_ID"])
    activate(
        arm,
        location=os.environ["LOC"],
        group=os.environ["RG"],
        storage=os.environ["SA"],
        app_name=os.environ["API"],
        function=os.environ["FUNC"],
        insights=os.environ["AI"],
        identity=os.environ["WATCHER_IDENTITY"],
    )


if __name__ == "__main__":
    try:
        main()
    except (DeploymentError, KeyError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        sys.exit(1)
