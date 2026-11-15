"""Render cache (docs/PLAN.md 4.4): Azure Blob when STORAGE_ACCOUNT_URL is set, else a local folder."""

from .blob import BlobCache, FrameCache, get_cache, query_key, render_key
from .local import LocalCache

__all__ = ["BlobCache", "FrameCache", "LocalCache", "get_cache", "query_key", "render_key"]
