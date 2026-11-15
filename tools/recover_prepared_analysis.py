"""Recover exact prepared-view measurement inputs without IRSA metadata.

Default: metadata-only discovery for one frame. --apply explicitly enables S3
cutout range reads and a create-only private sidecar upload after exact matching.
No public render/pointer writes; no full-image downloads or new exposure search.
Run with PYTHONPATH=backend and the backend Python environment.
"""

from __future__ import annotations

import argparse
import concurrent.futures as cf
import json
import re
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from urllib.parse import urlencode
from urllib.request import urlopen
from xml.etree import ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "backend"))

from app import config
from app.cache import BlobCache, render_key
from app.irsa import fetch
from app.models import ViewRequest
from app.processing import analysis_cache, stack, views

S3 = "https://nasa-irsa-spherex.s3.us-east-1.amazonaws.com/"
MANIFEST_RE = re.compile(
    r"(https://[a-z0-9]+\.blob\.core\.windows\.net/frames)/r/([a-f0-9]{24})/manifest\.json"
)
OBS_RE = re.compile(r"level2_(\d{4}W\d{2}_[1-4][A-D])_\d{4}_[1-4]D([1-6])")
NS = {"s": "http://s3.amazonaws.com/doc/2006-03-01/"}


class RecoveryError(ValueError):
    """An operator-safe failure without credential-bearing exception details."""


def read_public(url: str, limit: int = 4 * 1024 * 1024) -> bytes:
    with urlopen(url, timeout=15) as response:
        if response.geturl() != url:
            raise RecoveryError("Unexpected metadata redirect")
        body = response.read(limit + 1)
    if len(body) > limit:
        raise RecoveryError("Public metadata/render read exceeded size cap")
    return body


class PublicContainer:
    """Bounded read-only adapter for BlobCache's explicit public-client injection."""

    def __init__(self, base: str):
        self.base = base

    def download_blob(self, name: str):
        if not re.fullmatch(r"r/[a-f0-9]{24}/(?:manifest\.json|e\d+\.f32)", name):
            raise RecoveryError(
                "Only original public manifest/image reads are permitted"
            )
        data = read_public(f"{self.base}/{name}")
        return SimpleNamespace(readall=lambda: data)


class Resolver:
    """Small exact-prefix listings, never bucket scans or version guessing."""

    def __init__(self, max_requests: int = 256, reader=read_public):
        self.max_requests = max_requests
        self.requests = 0
        self.reader = reader
        self.groups: dict[str, list[str]] = {}

    def listing(self, prefix: str, delimiter: str | None = None):
        if self.requests >= self.max_requests:
            raise RecoveryError("S3 metadata request budget exhausted")
        self.requests += 1
        params = {"list-type": "2", "prefix": prefix, "max-keys": "100"}
        if delimiter:
            params["delimiter"] = delimiter
        root = ET.fromstring(self.reader(S3 + "?" + urlencode(params), 64 * 1024))
        if root.findtext("s:IsTruncated", namespaces=NS) != "false":
            raise RecoveryError(
                "S3 prefix listing is truncated; refusing broad discovery"
            )
        return root

    def resolve(self, frame: dict) -> dict:
        obs = frame.get("obs", "")
        match = OBS_RE.fullmatch(obs)
        collection = frame.get("collection")
        if (
            not match
            or collection not in ("spherex_dr1", "spherex_qr3")
            or type(frame.get("detector")) is not int
            or frame["detector"] != int(match.group(2))
        ):
            raise RecoveryError(
                "Unsupported observation, collection, or detector identity"
            )
        prefix = f"{collection.removeprefix('spherex_')}/level2/{match.group(1)}/"
        if prefix not in self.groups:
            root = self.listing(prefix, "/")
            folders = [e.text for e in root.findall("s:CommonPrefixes/s:Prefix", NS)]
            if not folders or len(folders) > 4:
                raise RecoveryError("Missing or excessive processing versions")
            if any(
                not re.fullmatch(re.escape(prefix) + r"l2b-v\d+-\d{4}-\d{3}/", p)
                for p in folders
            ):
                raise RecoveryError("Unexpected processing folder layout")
            self.groups[prefix] = folders
        candidates = []
        for folder in self.groups[prefix]:
            root = self.listing(f"{folder}{frame['detector']}/{obs}_spx_")
            version = folder.rstrip("/").rsplit("/", 1)[1]
            expected = f"{folder}{frame['detector']}/{obs}_spx_{version}.fits"
            for row in root.findall("s:Contents", NS):
                if row.findtext("s:Key", namespaces=NS) == expected:
                    candidates.append(expected)
        if len(candidates) != 1:
            raise RecoveryError(
                "Observation has no unique processing-version candidate"
            )
        return {
            "obs": obs,
            "collection": collection,
            "t_mjd": frame["t_mjd"],
            "band": f"SPHEREx-D{frame['detector']}",
            "url": "https://irsa.ipac.caltech.edu/ibe/data/spherex/" + candidates[0],
        }


def validate_manifest(manifest: dict, target: dict, rk: str) -> ViewRequest:
    if (
        manifest.get("schema") != 1
        or manifest.get("pipeline_version") != 3
        or config.PIPELINE_VERSION != 3
        or manifest.get("source") != "irsa"
        or manifest.get("render_key") != rk
        or target.get("preset_id")
    ):
        raise RecoveryError(
            "Only exact pipeline-3 nonpreset live prepared views are supported"
        )
    req = ViewRequest(**target["view"]["query"])
    if manifest["query"] != {
        key: getattr(req, key) for key in ("ra", "dec", "fov_arcmin", "band")
    }:
        raise RecoveryError("Catalog query differs from original manifest")
    frames = manifest["frames"]
    if not 1 <= len(frames) <= 120 or len({f["obs"] for f in frames}) != len(frames):
        raise RecoveryError("Invalid or excessive original frame inventory")
    if [
        sum(f["epoch"] == i for f in frames) for i in range(len(manifest["epochs"]))
    ] != [e["n_frames"] for e in manifest["epochs"]]:
        raise RecoveryError("Original pass counts disagree with frame inventory")
    if render_key(3, views.query_key(req), [f["obs"] for f in frames]) != rk:
        raise RecoveryError(
            "Original frame/query identity does not reproduce the render key"
        )
    return req


def bounded_s3_open(key: str):
    # Same native range-only extractor, with explicit network and retry bounds.
    return fetch.fits.open(
        f"s3://nasa-irsa-spherex/{key}",
        use_fsspec=True,
        fsspec_kwargs={
            "anon": True,
            "default_block_size": 256 * 1024,
            "config_kwargs": {
                "connect_timeout": 10,
                "read_timeout": 20,
                "retries": {"max_attempts": 1},
            },
        },
    )


def rebuild(
    manifest: dict, req: ViewRequest, rows: list[dict], cache, rk: str
) -> bytes:
    if [r["obs"] for r in rows] != [f["obs"] for f in manifest["frames"]]:
        raise RecoveryError("Recovery must preserve the complete original frame order")
    size = (req.fov_arcmin + 1) / 60
    with (
        patch.object(fetch, "_open_s3", bounded_s3_open),
        cf.ThreadPoolExecutor(max_workers=4) as pool,
    ):
        # map preserves order, including observations tied at the same timestamp.
        frames = list(
            pool.map(lambda row: fetch.fetch_s3(row, req.ra, req.dec, size), rows)
        )
    if any(frame is None for frame in frames):
        raise RecoveryError(
            "At least one original cutout failed; no partial recovery is allowed"
        )
    w, shape = stack.common_grid(req.ra, req.dec, req.fov_arcmin)
    for frame in frames:
        if any(
            getattr(frame.get(name), "nbytes", 0) > fetch.MAX_CUTOUT_BYTES
            for name in ("image", "var", "flags")
        ):
            raise RecoveryError("Native cutout exceeds size cap")
        frame["_grid"] = stack.to_grid(frame, w, shape)
    epochs = views.select_epochs(
        stack.group_epochs(frames), config.MIN_EPOCH_FRAMES_LIVE, False
    )
    if [len(ep) for ep in epochs] != [e["n_frames"] for e in manifest["epochs"]]:
        raise RecoveryError(
            "Rebuilt passes differ from original; science gates remain unchanged"
        )
    catalog = manifest["catalog"]
    rebuilt, files = views._render(
        views.Job(qk=views.query_key(req), req=req),
        rk,
        epochs,
        w,
        shape,
        "irsa",
        manifest["origin"],
        catalog["collections"],
        catalog["version"],
        [],
        None,
    )
    for field in (
        "schema",
        "render_key",
        "source",
        "pipeline_version",
        "query",
        "grid",
        "catalog",
        "origin",
        "stretch",
        "bandpass_matched",
        "epochs",
        "frames",
    ):
        if rebuilt[field] != manifest[field]:
            raise RecoveryError(
                f"Rebuilt {field} differs from original; no sidecar written"
            )
    image_names = {e["image"] for e in manifest["epochs"]}
    if image_names != {name for name in files if name.endswith(".f32")}:
        raise RecoveryError("Rebuilt image inventory differs from original")
    views._verify_render(cache, rk, rebuilt, files)
    data = analysis_cache.encode(rk, epochs, shape)
    analysis_cache.decode(
        data, rk, manifest
    )  # validate the final lossless artifact before upload
    return data


def private_cache(args, base: str):
    from azure.identity import AzureCliCredential
    from azure.storage.blob import BlobServiceClient

    from infra.azure_arm import Arm

    arm = Arm(
        args.subscription, args.tenant
    )  # explicit Azure for Students guard, no resource mutations
    account_url = base.removesuffix("/frames")
    account_name = account_url.removeprefix("https://").split(".", 1)[0]
    resource = arm.resource(
        args.resource_group, "Microsoft.Storage/storageAccounts", account_name
    )
    account = arm.request("GET", resource + "?api-version=2023-05-01")
    if (
        account.get("properties", {})
        .get("primaryEndpoints", {})
        .get("blob", "")
        .rstrip("/")
        != account_url
    ):
        raise RecoveryError(
            "Blob destination is not the verified Student subscription storage account"
        )
    credential = AzureCliCredential(
        tenant_id=args.tenant, subscription=args.subscription
    )
    service = BlobServiceClient(
        account_url,
        credential=credential,
        retry_total=1,
        connection_timeout=5,
        read_timeout=20,
    )
    client = service.get_container_client("state")
    if client.get_container_properties().get("public_access") is not None:
        raise RecoveryError(
            "Analysis destination must be an existing private state container"
        )
    return BlobCache(
        account_url,
        "frames",
        base,
        container_client=PublicContainer(base),
        analysis_client=client,
    )


def write_private(cache, rk: str, data: bytes) -> None:
    from azure.storage.blob import ContentSettings

    if cache.analysis is None:
        raise RecoveryError(
            "An explicitly injected private analysis client is required"
        )
    cache.analysis.upload_blob(
        f"analysis/v1/{rk}.npz",
        data,
        overwrite=False,
        content_settings=ContentSettings(
            content_type="application/octet-stream", cache_control="private, no-store"
        ),
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target", required=True)
    parser.add_argument(
        "--catalog", type=Path, default=ROOT / "frontend/public/catalog/points.json"
    )
    parser.add_argument("--apply", action="store_true")
    parser.add_argument(
        "--limit", type=int, default=1, help="Dry-run metadata frames only (1-120)"
    )
    parser.add_argument(
        "--max-list-requests",
        type=int,
        default=256,
        choices=range(1, 513),
        metavar="1..512",
    )
    parser.add_argument("--subscription")
    parser.add_argument("--tenant")
    parser.add_argument("--resource-group")
    args = parser.parse_args()
    if not 1 <= args.limit <= 120:
        parser.error("--limit must be 1-120")
    catalog = json.loads(args.catalog.read_text(encoding="utf-8"))
    target = next((obj for obj in catalog["objects"] if obj["id"] == args.target), None)
    if target is None:
        raise RecoveryError("Target ID is not in the bundled prepared catalog")
    match = MANIFEST_RE.fullmatch(target["view"]["manifest_url"])
    if not match:
        raise RecoveryError("Target must reference an immutable public Blob manifest")
    base, rk = match.groups()
    manifest = json.loads(read_public(target["view"]["manifest_url"]))
    req = validate_manifest(manifest, target, rk)
    cache = None
    if args.apply:
        if not args.subscription or not args.tenant or not args.resource_group:
            parser.error(
                "--apply requires explicit --subscription, --tenant and --resource-group"
            )
        cache = private_cache(args, base)
        if cache.read_analysis(rk) is not None:
            print("Private analysis already exists; left unchanged")
            return
    resolver = Resolver(args.max_list_requests)
    original = manifest["frames"] if args.apply else manifest["frames"][: args.limit]
    rows = [resolver.resolve(frame) for frame in original]
    print(
        json.dumps(
            {
                "target": args.target,
                "render_key": rk,
                "original_frames": len(manifest["frames"]),
                "resolved": len(rows),
                "metadata_requests": resolver.requests,
                "mode": "apply" if args.apply else "metadata-only",
                "candidates": rows if not args.apply else [],
            }
        )
    )
    if args.apply:
        data = rebuild(manifest, req, rows, cache, rk)
        write_private(cache, rk, data)
        print(f"Created private exact-match analysis sidecar: {len(data)} bytes")


if __name__ == "__main__":
    try:
        main()
    except RecoveryError as error:
        print(f"Recovery refused: {error}", file=sys.stderr)
        sys.exit(1)
    except Exception as error:  # noqa: BLE001 - cloud exceptions may contain credentials
        print(
            f"Recovery failed ({type(error).__name__}); service details withheld",
            file=sys.stderr,
        )
        sys.exit(1)
