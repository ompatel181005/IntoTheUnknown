"""Offline tests for public manifest inventory collection and honest unknowns."""

import importlib.util
import json
from pathlib import Path

import pytest

SPEC = importlib.util.spec_from_file_location(
    "catalog_data_stats", Path(__file__).resolve().parents[1] / "catalog_data_stats.py"
)
stats = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(stats)
KEY = "a" * 24
URL = f"https://example.blob.core.windows.net/frames/r/{KEY}/manifest.json"


def manifest():
    return {
        "schema": 1,
        "render_key": KEY,
        "source": "golden",
        "frames": [{"detector": 1}, {"detector": 1}, {"detector": 6}],
        "epochs": [{"n_frames": 2}, {"n_frames": 1}],
        "extras": {"gaia": "gaia.json"},
    }


def test_counts_use_inventory_not_origin_or_duplicate_detectors():
    data = manifest()
    data["origin"] = {"files": 999, "archive_exposures": 888}
    result = stats.summarize(URL, data)
    assert (result["frames"], result["passes"], result["bands"]) == (3, 2, 2)
    assert result["has_gaia"] is True
    assert result["source"] == "golden"
    assert result["render_key"] == KEY


@pytest.mark.parametrize("field", ["frames", "epochs", "extras"])
def test_missing_fields_are_unknown(field):
    data = manifest()
    del data[field]
    result = stats.summarize(URL, data)
    assert (
        result[{"frames": "frames", "epochs": "passes", "extras": "has_gaia"}[field]]
        is None
    )
    if field == "frames":
        assert result["bands"] is None


@pytest.mark.parametrize("detector", [None, True, 0, 7, "1"])
def test_invalid_detector_does_not_understate_band_count(detector):
    data = manifest()
    data["frames"][0]["detector"] = detector
    assert stats.summarize(URL, data)["bands"] is None


def test_empty_inventory_is_known_zero_and_null_gaia_is_absent():
    data = manifest()
    data.update(frames=[], epochs=[], extras={"gaia": None})
    result = stats.summarize(URL, data)
    assert (result["frames"], result["passes"], result["bands"]) == (0, 0, 0)
    assert result["has_gaia"] is False


@pytest.mark.parametrize(
    "change", [{"render_key": "b" * 24}, {"schema": 2}, {"epochs": [{"n_frames": 5}]}]
)
def test_rejects_stale_or_contradictory_manifest(change):
    data = manifest()
    data.update(change)
    with pytest.raises(ValueError):
        stats.summarize(URL, data)


@pytest.mark.parametrize(
    "url",
    [URL + "?example=query", URL.replace("https:", "http:"), URL.replace("/r/", "/q/")],
)
def test_rejects_nonimmutable_or_signed_urls(url):
    with pytest.raises(ValueError):
        stats.render_key(url)


def test_collection_preserves_case_and_failure_is_unknown():
    catalog = {"objects": [{"id": "CaseID", "view": {"manifest_url": URL}}]}

    def failing_fetch(url):
        raise TimeoutError("unavailable")

    result = stats.collect(catalog, failing_fetch)
    assert list(result["objects"]) == ["CaseID"]
    entry = result["objects"]["CaseID"]
    assert entry["manifest_url"] == URL
    assert entry["render_key"] == KEY
    assert all(
        entry[field] is None for field in ("frames", "passes", "bands", "has_gaia")
    )


def test_duplicate_ids_are_rejected_before_network():
    with pytest.raises(ValueError, match="unique"):
        stats.collect({"objects": [{"id": "same"}, {"id": "same"}]})


@pytest.mark.parametrize("objects", [None, {}, [None], ["bad"]])
def test_malformed_catalog_rejected(objects):
    with pytest.raises(TypeError):
        stats.collect({"objects": objects})


def test_bundled_snapshot_matches_current_catalog_and_has_valid_counts():
    directory = Path(__file__).resolve().parents[2] / "frontend/public/catalog"
    catalog = json.loads((directory / "points.json").read_text(encoding="utf-8"))
    snapshot = json.loads(
        (directory / "data-availability.json").read_text(encoding="utf-8")
    )
    assert snapshot["schema"] == 1
    assert snapshot["catalog_version"] == catalog["version"]
    assert set(snapshot["objects"]) == {obj["id"] for obj in catalog["objects"]}
    for obj in catalog["objects"]:
        entry = snapshot["objects"][obj["id"]]
        assert entry["manifest_url"] == obj["view"]["manifest_url"]
        assert entry["render_key"] == stats.render_key(entry["manifest_url"])
        for field in ("frames", "passes", "bands"):
            assert entry[field] is None or (
                type(entry[field]) is int and entry[field] >= 0
            )
        assert entry["bands"] is None or entry["bands"] <= 6
        assert entry["has_gaia"] is None or type(entry["has_gaia"]) is bool
