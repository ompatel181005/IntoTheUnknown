"""Small ARM client: credentials and secure deployment parameters stay in memory.

Never log response bodies: listSecrets, app settings and deployment errors can
contain credentials. This module uses the human's Azure CLI login, not shared keys.
"""

from __future__ import annotations

import json
import os
import re
import secrets
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path

ARM = "https://management.azure.com"
APP_API = "2024-03-01"
GUID = re.compile(r"^[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$")


class DeploymentError(RuntimeError):
    """An intentionally credential-free operator error."""


def az_json(*args: str) -> dict:
    result = subprocess.run(
        [
            os.environ.get("AZ_CLI", "az.cmd" if os.name == "nt" else "az"),
            *args,
            "--only-show-errors",
            "-o",
            "json",
        ],
        capture_output=True,
        check=False,
        text=True,
    )
    if result.returncode:
        raise DeploymentError(
            "Azure CLI failed; check login/permissions (output withheld)."
        )
    try:
        return json.loads(result.stdout)
    except ValueError:
        raise DeploymentError(
            "Azure CLI returned invalid JSON (output withheld)."
        ) from None


class Arm:
    def __init__(self, subscription: str, tenant: str):
        if not GUID.fullmatch(subscription) or not GUID.fullmatch(tenant):
            raise DeploymentError(
                "Explicit Student subscription and tenant GUIDs are required."
            )
        account = az_json("account", "show", "--subscription", subscription)
        if (
            account.get("id", "").lower() != subscription.lower()
            or account.get("tenantId", "").lower() != tenant.lower()
            or account.get("name") != "Azure for Students"
        ):
            raise DeploymentError(
                "Subscription/tenant/name does not match Azure for Students."
            )
        self.subscription = subscription
        self.root = f"/subscriptions/{subscription}"

    def request(self, method: str, path: str, body=None, *, missing_ok=False):
        # Do not send an ARM bearer token to a URL supplied by a response or caller.
        if not path.lower().startswith(self.root.lower() + "/") or ".." in path:
            raise DeploymentError("ARM request is outside the explicit subscription.")
        token = az_json(
            "account",
            "get-access-token",
            "--subscription",
            self.subscription,
            "--resource",
            ARM + "/",
        )["accessToken"]
        request = urllib.request.Request(
            ARM + path,
            data=None if body is None else json.dumps(body).encode(),
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
            },
            method=method,
        )
        try:
            with urllib.request.urlopen(request, timeout=90) as response:
                data = response.read()
                return json.loads(data) if data else {}
        except urllib.error.HTTPError as error:
            if error.code == 404 and missing_ok:
                return None
            # Do not include URL, response body, or original exception in the error.
            raise DeploymentError(
                f"ARM {method} failed (HTTP {error.code}); output withheld."
            ) from None
        except (urllib.error.URLError, TimeoutError, ValueError):
            raise DeploymentError(
                "ARM request failed or returned invalid JSON; output withheld."
            ) from None

    def resource(self, group: str, kind: str, name: str) -> str:
        if not all(re.fullmatch(r"[A-Za-z0-9_.-]+", value) for value in (group, name)):
            raise DeploymentError("Invalid resource name.")
        return f"{self.root}/resourceGroups/{group}/providers/{kind}/{name}"

    def deploy(self, group: str, name: str, template: Path, parameters: dict):
        path = (
            self.resource(group, "Microsoft.Resources/deployments", name)
            + "?api-version=2022-09-01"
        )
        self.request(
            "PUT",
            path,
            {
                "properties": {
                    "mode": "Incremental",
                    "template": json.loads(template.read_text()),
                    "parameters": {
                        key: {"value": value} for key, value in parameters.items()
                    },
                }
            },
        )
        deadline = time.monotonic() + 900
        while time.monotonic() < deadline:
            state = self.request("GET", path)["properties"]["provisioningState"]
            if state == "Succeeded":
                return
            if state in ("Failed", "Canceled"):
                raise DeploymentError(
                    f"ARM deployment {state}; inspect Azure operation status securely."
                )
            time.sleep(5)
        raise DeploymentError(
            "Timed out waiting for ARM deployment; inspect Azure before retrying."
        )


def refresh_secret(arm: Arm, app_id: str) -> str | None:
    """None means absent. A named secret with a withheld value is an error."""
    body = arm.request("POST", app_id + f"/listSecrets?api-version={APP_API}", {})
    for entry in body.get("value", []):
        if entry.get("name") == "refresh-key":
            value = entry.get("value")
            if not isinstance(value, str) or not value:
                raise DeploymentError(
                    "Existing refresh-key value is unavailable; refusing rotation."
                )
            return value
    return None


def deployment_refresh_secret(arm: Arm, app_id: str, app: dict | None) -> str:
    """Initialize only an unwired bootstrap; never replace an enabled/withheld key."""
    if app is None:
        return secrets.token_urlsafe(48)
    secret = refresh_secret(arm, app_id)
    if secret is not None:
        return secret
    containers = app.get("properties", {}).get("template", {}).get("containers", [])
    if any(
        item.get("name") == "REFRESH_KEY"
        for container in containers
        for item in container.get("env", [])
    ):
        raise DeploymentError(
            "REFRESH_KEY is wired but its secret is absent; refusing replacement."
        )
    return secrets.token_urlsafe(48)
