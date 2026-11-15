"""Image deployments must not remove secured or pending custom hostnames."""

import copy
import json
import os
import sys
from pathlib import Path
from unittest.mock import patch

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import deploy_app


@pytest.mark.parametrize(
    "current",
    [
        None,
        {"properties": {"configuration": {"ingress": None}}},
        {"properties": {"configuration": {"ingress": {"customDomains": None}}}},
    ],
)
def test_bootstrap_or_unbound_app_has_no_hostname_bindings(current):
    assert deploy(current)["customDomains"] == []


def test_image_update_preserves_certificate_and_pending_hostname():
    domains = [
        {
            "name": "space.example.test",
            "bindingType": "SniEnabled",
            "certificateId": "/subscriptions/test/certificates/managed",
        },
        {"name": "pending.example.test", "bindingType": "Disabled"},
    ]
    current = {"properties": {"configuration": {"ingress": {"customDomains": domains}}}}
    before = copy.deepcopy(current)
    assert deploy(current)["customDomains"] == domains
    assert current == before


def test_template_applies_the_preserved_domains_to_https_ingress():
    template = json.loads(
        (Path(deploy_app.__file__).parent / "containerapp.json").read_text()
    )
    assert template["parameters"]["customDomains"] == {
        "type": "array",
        "defaultValue": [],
    }
    ingress = template["resources"][0]["properties"]["configuration"]["ingress"]
    assert ingress["customDomains"] == "[parameters('customDomains')]"
    assert ingress["external"] is True and ingress["allowInsecure"] is False


def deploy(current):
    class FakeArm:
        def resource(self, *args):
            return "/subscriptions/test/resourceGroups/rg/providers/Microsoft.App/containerApps/api"

        def request(self, method, path, *args, **kwargs):
            if method == "GET":
                return current
            assert path.endswith("/listSecrets?api-version=2024-03-01")
            return {
                "value": [
                    {"name": "refresh-key", "value": "test-only-not-a-credential"}
                ]
            }

        def deploy(self, group, name, template, parameters):
            self.parameters = parameters

    arm = FakeArm()
    args = [
        "deploy_app.py",
        "--image",
        "image:test",
        "--location",
        "westus",
        "--environment-id",
        "env",
        "--identity-id",
        "identity",
        "--client-id",
        "client",
        "--min-replicas",
        "1",
    ]
    env = {
        "AZ_SUBSCRIPTION_ID": "test",
        "AZ_TENANT_ID": "test",
        "RG": "rg",
        "API": "api",
        "ACR": "registry",
        "SA": "storage",
        "FRAMES_CONTAINER": "frames",
        "STATE_CONTAINER": "state",
        "AI": "insights",
    }
    with (
        patch.object(sys, "argv", args),
        patch.dict(os.environ, env),
        patch.object(deploy_app, "Arm", return_value=arm),
    ):
        deploy_app.main()
    return arm.parameters
