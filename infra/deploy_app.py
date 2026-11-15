"""Full Container App ARM redeploy, preserving REFRESH_KEY without CLI secret args."""

import argparse
import os
import sys
from pathlib import Path

from azure_arm import APP_API, Arm, DeploymentError, deployment_refresh_secret


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("image", "location", "environment-id", "identity-id", "client-id"):
        parser.add_argument("--" + name, required=True)
    parser.add_argument("--min-replicas", type=int, choices=(0, 1), required=True)
    args = parser.parse_args()
    arm = Arm(os.environ["AZ_SUBSCRIPTION_ID"], os.environ["AZ_TENANT_ID"])
    group, app = os.environ["RG"], os.environ["API"]
    app_id = arm.resource(group, "Microsoft.App/containerApps", app)
    current = arm.request("GET", app_id + f"?api-version={APP_API}", missing_ok=True)
    secret = deployment_refresh_secret(arm, app_id, current)
    arm.deploy(
        group,
        "core-app",
        Path(__file__).with_name("containerapp.json"),
        {
            "appName": app,
            "location": args.location,
            "environmentId": args.environment_id,
            "identityResourceId": args.identity_id,
            "identityClientId": args.client_id,
            "image": args.image,
            "registryServer": os.environ["ACR"] + ".azurecr.io",
            "storageAccountUrl": f"https://{os.environ['SA']}.blob.core.windows.net",
            "framesContainer": os.environ["FRAMES_CONTAINER"],
            "stateContainer": os.environ["STATE_CONTAINER"],
            "minReplicas": args.min_replicas,
            "applicationInsightsName": os.environ["AI"],
            "refreshKey": secret,
        },
    )
    print("Container App deployed with REFRESH_KEY stored as a secret.")


if __name__ == "__main__":
    try:
        main()
    except (DeploymentError, KeyError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        sys.exit(1)
