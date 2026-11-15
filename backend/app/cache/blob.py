"""Two-level render cache (docs/PLAN.md 4.4): `q/{qk}.json` pointers and immutable `r/{rk}/` renders.

Azure Blob through managed identity when STORAGE_ACCOUNT_URL is set; a local folder (CACHE_DIR) otherwise.
There is no connection string anywhere: DefaultAzureCredential picks up the Container App's identity in Azure
and `az login` on a laptop.
"""

import hashlib
import json
import logging
from typing import Protocol

from .. import config
from .local import LocalCache, analysis_key, safe_name

log = logging.getLogger("cache")

IMMUTABLE = "public, max-age=31536000, immutable"  # r/: a render key never changes content
SHORT = "public, max-age=60"  # q/: the pointer moves when the frame set changes

# name -> (bytes, content type), e.g. {"e0.f32": (b"...", "application/octet-stream")}
Files = dict[str, tuple[bytes, str]]


def query_key(
    ra: float, dec: float, fov_arcmin: int, band: str, source: str = "auto", pipeline_version: int | None = None
) -> str:
    """Same sky request -> same key. `.4f` is 0.36 arcsec, well under a pixel.

    These are the merged production rules (infra/BLOB-HANDOFF.md): q2 plus the pipeline version, which
    invalidated pointers made before dense saved captures used the ten-frame gate. Change them only on purpose.
    """
    pv = config.PIPELINE_VERSION if pipeline_version is None else pipeline_version
    key = f"q2|{pv}|{ra:.4f}|{dec:+.4f}|{fov_arcmin:g}|{band}"
    if source != "auto":  # a forced source is a different render
        key += f"|{source}"
    return hashlib.sha256(key.encode()).hexdigest()[:20]


def render_key(pipeline_version: int, qk: str, frame_ids: list[str]) -> str:
    """Same frames + same pipeline -> same render. New frames or a pipeline bump -> a new folder."""
    payload = f"{pipeline_version}|{qk}|{','.join(sorted(frame_ids))}"
    return hashlib.sha256(payload.encode()).hexdigest()[:24]


class FrameCache(Protocol):
    def lookup(self, qk: str) -> dict | None: ...  # {"render_key", "catalog_version"} or None
    def has_render(self, rk: str) -> bool: ...
    def put_render(self, rk: str, manifest: dict, files: Files) -> None: ...  # manifest last
    def point(self, qk: str, rk: str, catalog_version: str) -> None: ...  # after put_render
    def read(self, rk: str, name: str) -> bytes: ...  # one file of a render, manifest.json included
    def manifest_url(self, rk: str) -> str: ...
    def catalog(self) -> dict | None: ...  # meta/catalog.json from the new-data watcher; None until it has run
    def read_analysis(self, rk: str) -> bytes | None: ...
    def put_analysis(self, rk: str, data: bytes) -> None: ...


class BlobCache:
    def __init__(
        self, account_url: str, container: str, public_base: str = "", container_client=None, analysis_client=None
    ):
        if container_client is None:
            from azure.identity import DefaultAzureCredential
            from azure.storage.blob import BlobServiceClient

            # Bounded: the SDK defaults retry for minutes, and create() looks the pointer up under the jobs lock.
            service = BlobServiceClient(
                account_url, credential=DefaultAzureCredential(), retry_total=1, connection_timeout=5, read_timeout=20
            )
            container_client = service.get_container_client(container)
            analysis_client = service.get_container_client(config.STATE_CONTAINER)
        self.c = container_client
        self.analysis = analysis_client  # injected test clients must explicitly supply a separate private container
        self.public_base = (public_base or f"{account_url.rstrip('/')}/{container}").rstrip("/")

    def read_analysis(self, rk: str) -> bytes | None:
        from azure.core.exceptions import ResourceNotFoundError

        if self.analysis is None:
            return None
        try:
            return self.analysis.download_blob(f"analysis/v1/{analysis_key(rk)}.npz").readall()
        except ResourceNotFoundError:
            return None

    def put_analysis(self, rk: str, data: bytes) -> None:
        from azure.storage.blob import ContentSettings

        if self.analysis is not None:
            self.analysis.upload_blob(
                f"analysis/v1/{analysis_key(rk)}.npz",
                data,
                overwrite=True,
                content_settings=ContentSettings(
                    content_type="application/octet-stream", cache_control="private, no-store"
                ),
            )

    def _put(self, path: str, data: bytes, ctype: str, cache: str) -> None:
        from azure.storage.blob import ContentSettings

        self.c.upload_blob(
            path, data, overwrite=True, content_settings=ContentSettings(content_type=ctype, cache_control=cache)
        )

    def lookup(self, qk: str) -> dict | None:
        from azure.core.exceptions import AzureError, ResourceNotFoundError

        try:
            return json.loads(self.c.download_blob(f"q/{qk}.json").readall())
        except ResourceNotFoundError:
            return None
        except (AzureError, ValueError) as e:  # a miss costs a rebuild; an exception would cost the request
            log.warning("cache pointer q/%s unreadable, rebuilding: %s", qk, e)
            return None

    def has_render(self, rk: str) -> bool:
        return self.c.get_blob_client(f"r/{rk}/manifest.json").exists()

    def put_render(self, rk: str, manifest: dict, files: Files) -> None:
        for name, (data, ctype) in files.items():
            self._put(f"r/{rk}/{safe_name(name)}", data, ctype, IMMUTABLE)
        self._put(f"r/{rk}/manifest.json", json.dumps(manifest).encode(), "application/json", IMMUTABLE)  # last

    def point(self, qk: str, rk: str, catalog_version: str) -> None:
        body = json.dumps({"render_key": rk, "catalog_version": catalog_version}).encode()
        self._put(f"q/{qk}.json", body, "application/json", SHORT)

    def read(self, rk: str, name: str) -> bytes:
        return self.c.download_blob(f"r/{rk}/{name}").readall()

    def manifest_url(self, rk: str) -> str:
        return f"{self.public_base}/r/{rk}/manifest.json"

    def catalog(self) -> dict | None:
        from azure.core.exceptions import AzureError

        try:
            return json.loads(self.c.download_blob("meta/catalog.json").readall())
        except (AzureError, ValueError):  # missing, unreadable or not JSON: the badge just has no data
            return None


_cache: FrameCache | None = None


def get_cache() -> FrameCache:
    global _cache
    if _cache is None:
        if config.STORAGE_ACCOUNT_URL:
            _cache = BlobCache(config.STORAGE_ACCOUNT_URL, config.FRAMES_CONTAINER, config.FRAMES_PUBLIC_BASE)
            log.info("render cache: Azure Blob %s/%s", config.STORAGE_ACCOUNT_URL, config.FRAMES_CONTAINER)
        else:
            _cache = LocalCache(config.CACHE_DIR)
            log.info("render cache: local folder %s", config.CACHE_DIR)
    return _cache
