# SKELETON from the hackathon plan: not yet run against live IRSA or Azure.
# Destination: backend/app/cache/blob.py. Copy it there when you start that slice and delete this file in the same PR.

import hashlib, json
from azure.core.exceptions import ResourceNotFoundError
from azure.identity import DefaultAzureCredential
from azure.storage.blob import BlobServiceClient, ContentSettings

IMMUTABLE, SHORT = "public, max-age=31536000, immutable", "public, max-age=60"

def query_key(ra: float, dec: float, fov_arcmin: float, band: str) -> str:
    return hashlib.sha256(f"q1|{ra:.4f}|{dec:+.4f}|{fov_arcmin:g}|{band}".encode()).hexdigest()[:20]

def render_key(pipeline_version: int, qk: str, frame_ids: list[str]) -> str:
    payload = f"{pipeline_version}|{qk}|" + "\n".join(sorted(frame_ids))
    return hashlib.sha256(payload.encode()).hexdigest()[:24]

class FrameCache:
    def __init__(self, account_url: str, container: str = "frames"):
        self.c = BlobServiceClient(account_url, credential=DefaultAzureCredential()).get_container_client(container)

    def _put(self, path: str, data: bytes, ctype: str, cache: str) -> None:
        self.c.upload_blob(path, data, overwrite=True,
                           content_settings=ContentSettings(content_type=ctype, cache_control=cache))

    def get_json(self, path: str) -> dict | None:
        try:
            return json.loads(self.c.download_blob(path).readall())
        except ResourceNotFoundError:
            return None

    def lookup(self, qk: str) -> dict | None:                       # → {"render_key", "catalog_version"} or None
        return self.get_json(f"q/{qk}.json")

    def put_render(self, rk: str, manifest: dict, files: dict[str, tuple[bytes, str]]) -> None:
        for name, (data, ctype) in files.items():                   # e0.f32, e0.png, e0.mask.u8, gaia.json …
            self._put(f"r/{rk}/{name}", data, ctype, IMMUTABLE)
        self._put(f"r/{rk}/manifest.json", json.dumps(manifest).encode(), "application/json", IMMUTABLE)  # last

    def point(self, qk: str, rk: str, catalog_version: str) -> None: # atomic swap after the render is complete
        self._put(f"q/{qk}.json", json.dumps({"render_key": rk, "catalog_version": catalog_version}).encode(),
                  "application/json", SHORT)
