"""Swappable sources for sky-object catalog sets."""

from .store import (
    AzureBlobCatalogStore,
    CatalogLoadError,
    CatalogNotFound,
    CatalogStore,
    LocalCatalogStore,
    get_catalog_store,
)

__all__ = [
    "AzureBlobCatalogStore",
    "CatalogLoadError",
    "CatalogNotFound",
    "CatalogStore",
    "LocalCatalogStore",
    "get_catalog_store",
]
