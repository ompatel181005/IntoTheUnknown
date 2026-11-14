# Sky catalog

`GET /api/catalog?set=targets` serves the object positions and distances used by the 3D view. A set is a JSON document matching `Catalog` in `backend/app/models.py`, mirrored by the TypeScript types in `frontend/src/types.ts`. Additional files such as `nearby.json` or `gaia_overlay.json` become additional sets without frontend code changes.

The default store reads `backend/data/catalog/<set>.json`. To switch to Azure Blob, place the same documents at `<container>/catalog/<set>.json` and configure the backend:

```env
CATALOG_STORE=azure_blob
CATALOG_BLOB_URL=https://example.blob.core.windows.net/container/catalog
CATALOG_BLOB_TIMEOUT_S=10
CATALOG_CACHE_TTL_S=60
```

`CATALOG_BLOB_URL` may include a container SAS query string, or may point to a public container's `catalog` directory. The backend keeps the SAS token in the request only and removes it from the returned `source.uri`. Invalid JSON and documents that do not match the Pydantic schema return a `502 CATALOG_UNAVAILABLE` error.
