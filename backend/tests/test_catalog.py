"""Catalog contract and swappable store checks."""

import json

from fastapi.testclient import TestClient

import app.catalog.store as store_module
import app.main as main_module
from app.catalog.store import AzureBlobCatalogStore, LocalCatalogStore

client = TestClient(main_module.app)


def catalog_document() -> dict:
    return {
        "version": "test-v1",
        "generated_at": "2026-11-14T18:00:00Z",
        "source": {"kind": "local", "uri": "test/targets.json"},
        "objects": [
            {
                "id": "other-object",
                "name": "Other Object",
                "kind": "quasar",
                "ra_deg": 12.5,
                "dec_deg": -7.25,
                "ref_epoch": 2016.0,
                "parallax_mas": None,
                "parallax_err_mas": None,
                "distance_pc": 1000.0,
                "pmra_mas_yr": None,
                "pmdec_mas_yr": None,
                "preset_id": None,
                "provenance": {"catalog": "Test catalog", "ref": "https://example.test/catalog"},
            }
        ],
    }


def test_local_store_happy_path(tmp_path):
    document = catalog_document()
    (tmp_path / "targets.json").write_text(json.dumps(document))
    store = LocalCatalogStore(tmp_path)

    assert store.load("targets") == document
    assert store.version("targets") == "test-v1"


def test_unknown_set_uses_existing_error_shape():
    response = client.get("/api/catalog", params={"set": "does-not-exist"})

    assert response.status_code == 404
    assert response.json() == {
        "error": {
            "code": "UNKNOWN_CATALOG_SET",
            "message": "Catalog set 'does-not-exist' is not available.",
        }
    }


def test_malformed_local_json_returns_clear_502(tmp_path, monkeypatch):
    (tmp_path / "broken.json").write_text('{"version":')
    monkeypatch.setattr(main_module, "get_catalog_store", lambda: LocalCatalogStore(tmp_path))

    response = client.get("/api/catalog", params={"set": "broken"})

    assert response.status_code == 502
    body = response.json()["error"]
    assert body["code"] == "CATALOG_UNAVAILABLE"
    assert "invalid JSON" in body["message"]


def test_azure_store_uses_https_sas_and_short_cache(monkeypatch):
    calls: list[tuple[str, float]] = []
    payload = json.dumps(catalog_document()).encode()

    class Response:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return None

        def read(self):
            return payload

    def fake_urlopen(url: str, timeout: float):
        calls.append((url, timeout))
        return Response()

    monkeypatch.setattr(store_module.urllib.request, "urlopen", fake_urlopen)
    store = AzureBlobCatalogStore(
        "https://example.blob.core.windows.net/container/catalog?sig=secret",
        timeout_s=3.5,
        ttl_s=30,
    )

    first = store.load("targets")
    second = store.load("targets")

    assert first == second
    assert calls == [("https://example.blob.core.windows.net/container/catalog/targets.json?sig=secret", 3.5)]
    assert first["source"] == {
        "kind": "azure_blob",
        "uri": "https://example.blob.core.windows.net/container/catalog/targets.json",
    }
    assert store.version("targets") == "test-v1"
