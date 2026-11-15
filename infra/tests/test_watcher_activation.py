"""Offline activation tests: no Azure login, network, storage, or function execution."""

import copy
import io
import json
import sys
import unittest
import urllib.error
import zipfile
from contextlib import redirect_stdout
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import azure_arm
import watcher

SUB = "11111111-2222-3333-4444-555555555555"
TENANT = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
KEY = "fixture-only-refresh-key-do-not-log"
APP = {
    "location": "westus",
    "identity": {"type": "UserAssigned", "userAssignedIdentities": {"/identity": {}}},
    "properties": {
        "environmentId": "/environment",
        "workloadProfileName": "Consumption",
        "configuration": {"ingress": {"fqdn": "api.westus.azurecontainerapps.io"}},
        "template": {
            "containers": [
                {
                    "name": "api",
                    "image": "old-image",
                    "env": [
                        {"name": "OTHER", "value": "preserved"},
                    ],
                }
            ],
            "scale": {"maxReplicas": 1},
        },
    },
}


def bare_arm():
    arm = azure_arm.Arm.__new__(azure_arm.Arm)
    arm.subscription = SUB
    arm.root = f"/subscriptions/{SUB}"
    return arm


class SecurityTests(unittest.TestCase):
    def test_wrong_subscription_tenant_name_fail_before_token_or_mutation(self):
        for change in ({"id": TENANT}, {"tenantId": SUB}, {"name": "UIC-ACCC-WVD"}):
            with (
                self.subTest(change=change),
                patch.object(
                    azure_arm,
                    "az_json",
                    return_value={
                        "id": SUB,
                        "tenantId": TENANT,
                        "name": "Azure for Students",
                        **change,
                    },
                ) as cli,
            ):
                with self.assertRaises(azure_arm.DeploymentError):
                    azure_arm.Arm(SUB, TENANT)
                self.assertEqual(cli.call_count, 1)

    def test_foreign_arm_path_rejected_before_token(self):
        with patch.object(azure_arm, "az_json") as cli:
            with self.assertRaises(azure_arm.DeploymentError):
                bare_arm().request(
                    "GET", f"/subscriptions/{TENANT}/resourceGroups/other"
                )
            cli.assert_not_called()

    def test_secrets_only_in_http_body_never_cli_arguments_or_error(self):
        arm = bare_arm()
        with (
            patch.object(
                azure_arm, "az_json", return_value={"accessToken": KEY}
            ) as cli,
            patch.object(
                azure_arm.urllib.request,
                "urlopen",
                side_effect=urllib.error.HTTPError(
                    "https://arm.invalid", 400, KEY, {}, io.BytesIO(KEY.encode())
                ),
            ) as http,
        ):
            with self.assertRaises(azure_arm.DeploymentError) as caught:
                arm.request(
                    "PUT",
                    arm.root + "/resourceGroups/test?api-version=1",
                    {"refreshKey": KEY},
                )
            self.assertNotIn(KEY, str(caught.exception))
            self.assertNotIn(KEY, str(cli.call_args))
            self.assertIn(KEY.encode(), http.call_args.args[0].data)

    def test_new_app_bootstrap_generates_without_listing_absent_app(self):
        arm = Mock()
        key = azure_arm.deployment_refresh_secret(arm, "/app", None)
        self.assertGreaterEqual(len(key), 64)
        arm.request.assert_not_called()

    def test_existing_unwired_app_can_bootstrap_and_existing_key_is_preserved(self):
        arm = Mock()
        arm.request.return_value = {"value": []}
        self.assertGreaterEqual(
            len(azure_arm.deployment_refresh_secret(arm, "/app", APP)), 64
        )
        arm.request.return_value = {"value": [{"name": "refresh-key", "value": KEY}]}
        self.assertEqual(azure_arm.deployment_refresh_secret(arm, "/app", APP), KEY)

    def test_withheld_or_dangling_key_never_rotates(self):
        arm = Mock()
        arm.request.return_value = {"value": [{"name": "refresh-key"}]}
        with self.assertRaises(azure_arm.DeploymentError):
            azure_arm.deployment_refresh_secret(arm, "/app", APP)
        arm.request.return_value = {"value": []}
        app = copy.deepcopy(APP)
        app["properties"]["template"]["containers"][0]["env"].append(
            {"name": "REFRESH_KEY", "secretRef": "refresh-key"}
        )
        with self.assertRaises(azure_arm.DeploymentError):
            azure_arm.deployment_refresh_secret(arm, "/app", app)

    def test_api_wiring_preserves_identity_environment_other_secrets_and_settings(self):
        arm = Mock()
        arm.request.return_value = {
            "value": [{"name": "application-insights", "value": "other-fixture"}]
        }
        before = copy.deepcopy(APP)
        with redirect_stdout(io.StringIO()) as output:
            watcher.wire_api_secret(arm, "/app", APP, KEY)
        self.assertEqual(output.getvalue(), "")
        body = arm.request.call_args.args[2]
        self.assertEqual(body["properties"]["environmentId"], "/environment")
        self.assertEqual(body["properties"]["managedEnvironmentId"], "/environment")
        self.assertEqual(body["properties"]["workloadProfileName"], "Consumption")
        self.assertEqual(body["identity"], APP["identity"])
        self.assertEqual(
            body["properties"]["template"]["containers"][0]["image"], "old-image"
        )
        self.assertIn(
            {"name": "OTHER", "value": "preserved"},
            body["properties"]["template"]["containers"][0]["env"],
        )
        self.assertEqual(len(body["properties"]["configuration"]["secrets"]), 2)
        self.assertEqual(APP, before)

    def test_plan_has_no_cloud_calls(self):
        with (
            patch.object(sys, "argv", ["watcher.py", "--plan"]),
            patch.object(watcher, "Arm") as arm,
            redirect_stdout(io.StringIO()),
        ):
            watcher.main()
        arm.assert_not_called()


class ActivationTests(unittest.TestCase):
    def fake(self, *, shared_keys=False, configured=None):
        arm = bare_arm()

        def request(method, path, body=None, **kwargs):
            if "Microsoft.Storage" in path:
                return {"properties": {"allowSharedKeyAccess": shared_keys}}
            if "Microsoft.Insights" in path:
                return {}
            if "listSecrets" in path:
                return {"value": [{"name": "refresh-key", "value": KEY}]}
            if "/config/appsettings/list" in path:
                return {"properties": {"REFRESH_KEY": configured}}
            if "Microsoft.Web/sites" in path:
                return {"id": "/function"} if configured is not None else None
            return copy.deepcopy(APP)

        arm.request = Mock(side_effect=request)
        arm.deploy = Mock()
        return arm

    def apply(self, arm):
        watcher.activate(
            arm,
            location="westus",
            group="rg-planetx",
            storage="stplanetxtest",
            app_name="ca-planetx-api",
            function="func-planetx-test",
            insights="appi-planetx",
            identity="id-planetx-watcher",
        )

    def test_rerun_reuses_same_key_and_only_nonsecret_package_path_reaches_cli(self):
        arm = self.fake(configured=KEY)
        with (
            patch.object(
                watcher, "package_functions", return_value="fixture-package-hash"
            ),
            patch.object(
                watcher.subprocess,
                "run",
                return_value=Mock(returncode=0),
            ) as cli,
            redirect_stdout(io.StringIO()) as output,
        ):
            self.apply(arm)
        self.assertEqual(arm.deploy.call_args.args[3]["refreshKey"], KEY)
        self.assertNotIn(KEY, str(cli.call_args))
        self.assertNotIn(KEY, output.getvalue())
        command = cli.call_args.args[0]
        self.assertIn("config-zip", command)
        self.assertEqual(command[command.index("--build-remote") + 1], "true")
        self.assertEqual(command[command.index("--subscription") + 1], SUB)

    def test_shared_keys_or_mismatched_secret_refused_before_writes(self):
        for arm in (
            self.fake(shared_keys=True),
            self.fake(configured="different-fixture"),
        ):
            with self.assertRaises(azure_arm.DeploymentError):
                self.apply(arm)
            self.assertFalse(
                any(
                    call.args[0] in ("PUT", "PATCH")
                    for call in arm.request.call_args_list
                )
            )
            arm.deploy.assert_not_called()

    def test_template_has_only_container_scoped_data_roles_and_identity_connections(
        self,
    ):
        template = json.loads((watcher.HERE / "watcher.json").read_text())
        resources = template["resources"]
        self.assertFalse(
            any(
                item["type"]
                in (
                    "Microsoft.Storage/storageAccounts",
                    "Microsoft.Insights/components",
                )
                for item in resources
            )
        )
        roles = [
            item
            for item in resources
            if item["type"] == "Microsoft.Authorization/roleAssignments"
        ]
        self.assertEqual(len(roles), 6)
        ci_role = next(item for item in roles if "Microsoft.Web/sites" in item["scope"])
        self.assertIn("de139f84", ci_role["properties"]["roleDefinitionId"])
        self.assertIn("ciIdentityName", ci_role["properties"]["principalId"])
        roles = [item for item in roles if item is not ci_role]
        self.assertTrue(
            all("blobServices/containers" in item["scope"] for item in roles)
        )
        self.assertEqual(
            sum("b7e6dc6d" in item["properties"]["roleDefinitionId"] for item in roles),
            2,
        )
        self.assertEqual(
            sum("ba92f5b4" in item["properties"]["roleDefinitionId"] for item in roles),
            3,
        )
        function = next(
            item for item in resources if item["type"] == "Microsoft.Web/sites"
        )
        config = function["properties"]["functionAppConfig"]
        self.assertEqual(config["runtime"], {"name": "python", "version": "3.11"})
        self.assertEqual(
            config["scaleAndConcurrency"],
            {"maximumInstanceCount": 1, "instanceMemoryMB": 2048, "alwaysReady": []},
        )
        self.assertEqual(
            config["deployment"]["storage"]["authentication"]["type"],
            "UserAssignedIdentity",
        )
        settings = {
            entry["name"]: entry["value"]
            for entry in function["properties"]["siteConfig"]["appSettings"]
        }
        self.assertEqual(settings["AzureWebJobsStorage__credential"], "managedidentity")
        self.assertEqual(
            settings["AzureWebJobsStorage__clientId"], settings["AZURE_CLIENT_ID"]
        )
        self.assertEqual(
            template["parameters"]["refreshKey"]["type"].lower(), "securestring"
        )

    def test_package_is_committed_runtime_only_at_zip_root(self):
        with TemporaryDirectory() as folder:
            package = Path(folder) / "package.zip"
            digest = watcher.package_functions(package)
            self.assertEqual(len(digest), 64)
            with zipfile.ZipFile(package) as archive:
                names = archive.namelist()
                self.assertIn("function_app.py", names)
                self.assertIn("host.json", names)
                self.assertFalse(
                    any(
                        name.startswith("functions/")
                        or "settings" in name
                        or "tests" in name
                        for name in names
                    )
                )

    def test_full_app_template_preserves_refresh_secret_reference(self):
        template = json.loads((watcher.HERE / "containerapp.json").read_text())
        self.assertEqual(
            template["parameters"]["refreshKey"]["type"].lower(), "securestring"
        )
        props = template["resources"][0]["properties"]
        self.assertIn(
            {"name": "refresh-key", "value": "[parameters('refreshKey')]"},
            props["configuration"]["secrets"],
        )
        self.assertIn(
            {"name": "REFRESH_KEY", "secretRef": "refresh-key"},
            props["template"]["containers"][0]["env"],
        )


if __name__ == "__main__":
    unittest.main()
