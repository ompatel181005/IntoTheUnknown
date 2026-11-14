"""Catalog storage adapters. API validation remains in the route boundary."""

import json
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from functools import lru_cache
from pathlib import Path
from typing import Protocol

from .. import config

_SET_NAME = re.compile(r"^[A-Za-z0-9_-]+$")


class CatalogNotFound(Exception):
    """The requested set does not exist in the selected store."""


class CatalogLoadError(Exception):
    """The selected store could not return usable JSON."""


class CatalogStore(Protocol):
    def load(self, set_name: str) -> dict:
        """Load one catalog document."""

    def version(self, set_name: str) -> str:
        """Return the catalog document version."""


def _safe_set_name(set_name: str) -> str:
    if not _SET_NAME.fullmatch(set_name):
        raise CatalogNotFound(f"Unknown catalog set: {set_name}")
    return set_name


def _decode(payload: bytes, set_name: str) -> dict:
    try:
        value = json.loads(payload)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise CatalogLoadError(f"Catalog set '{set_name}' contains invalid JSON: {exc}") from exc
    if not isinstance(value, dict):
        raise CatalogLoadError(f"Catalog set '{set_name}' must contain a JSON object.")
    return value


def _version(document: dict, set_name: str) -> str:
    value = document.get("version")
    if not isinstance(value, str) or not value:
        raise CatalogLoadError(f"Catalog set '{set_name}' has no valid version.")
    return value


class LocalCatalogStore:
    def __init__(self, directory: Path | None = None):
        self.directory = directory or config.ROOT / "backend" / "data" / "catalog"

    def load(self, set_name: str) -> dict:
        name = _safe_set_name(set_name)
        path = self.directory / f"{name}.json"
        try:
            return _decode(path.read_bytes(), name)
        except FileNotFoundError as exc:
            raise CatalogNotFound(f"Unknown catalog set: {name}") from exc
        except OSError as exc:
            raise CatalogLoadError(f"Could not read catalog set '{name}': {exc}") from exc

    def version(self, set_name: str) -> str:
        return _version(self.load(set_name), set_name)


class AzureBlobCatalogStore:
    def __init__(self, base_url: str, timeout_s: float = 10, ttl_s: float = 60):
        parts = urllib.parse.urlsplit(base_url)
        if parts.scheme != "https" or not parts.netloc:
            raise CatalogLoadError("CATALOG_BLOB_URL must be an HTTPS container or catalog URL.")
        self.base_url = base_url
        self.timeout_s = timeout_s
        self.ttl_s = ttl_s
        self._cache: dict[str, tuple[float, dict]] = {}
        self._lock = threading.Lock()

    def _url(self, set_name: str) -> str:
        parts = urllib.parse.urlsplit(self.base_url)
        path = f"{parts.path.rstrip('/')}/{set_name}.json"
        return urllib.parse.urlunsplit((parts.scheme, parts.netloc, path, parts.query, ""))

    def load(self, set_name: str) -> dict:
        name = _safe_set_name(set_name)
        now = time.monotonic()
        with self._lock:
            cached = self._cache.get(name)
            if cached and now - cached[0] < self.ttl_s:
                return cached[1]

        url = self._url(name)
        try:
            with urllib.request.urlopen(url, timeout=self.timeout_s) as response:
                document = _decode(response.read(), name)
        except urllib.error.HTTPError as exc:
            if exc.code == 404:
                raise CatalogNotFound(f"Unknown catalog set: {name}") from exc
            raise CatalogLoadError(f"Azure Blob returned HTTP {exc.code} for catalog set '{name}'.") from exc
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            raise CatalogLoadError(f"Could not load catalog set '{name}' from Azure Blob: {exc}") from exc

        public_uri = urllib.parse.urlunsplit((*urllib.parse.urlsplit(url)[:3], "", ""))
        document["source"] = {"kind": "azure_blob", "uri": public_uri}
        with self._lock:
            self._cache[name] = (now, document)
        return document

    def version(self, set_name: str) -> str:
        return _version(self.load(set_name), set_name)


@lru_cache(maxsize=4)
def _store_for_settings(store_kind: str, blob_url: str, timeout_s: float, ttl_s: float) -> CatalogStore:
    if store_kind == "local":
        return LocalCatalogStore()
    if store_kind == "azure_blob":
        if not blob_url:
            raise CatalogLoadError("CATALOG_BLOB_URL is required when CATALOG_STORE=azure_blob.")
        return AzureBlobCatalogStore(blob_url, timeout_s=timeout_s, ttl_s=ttl_s)
    raise CatalogLoadError("CATALOG_STORE must be either 'local' or 'azure_blob'.")


def get_catalog_store() -> CatalogStore:
    return _store_for_settings(
        config.CATALOG_STORE,
        config.CATALOG_BLOB_URL,
        config.CATALOG_BLOB_TIMEOUT_S,
        config.CATALOG_CACHE_TTL_S,
    )
