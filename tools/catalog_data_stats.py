"""Bundle counts from existing catalog Blob manifests; never fetch image data.

Run from the repository root: python tools/catalog_data_stats.py
The snapshot describes the exact prepared views in points.json, including Blob
copies of saved targets, not the separate /golden/ default-view manifests.
Missing/invalid metadata remains null. Gaia availability means an extras.gaia
asset is advertised, not that it contains a match to the selected target.
"""

from __future__ import annotations

import argparse
import json
import re
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
from pathlib import Path
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[1]
MAX_MANIFEST_BYTES = 2 * 1024 * 1024
MANIFEST_URL = re.compile(
    r"https://[a-z0-9]+\.blob\.core\.windows\.net/frames/r/([a-f0-9]{24})/manifest\.json"
)


def render_key(url: str) -> str:
    """Accept only public immutable Blob manifest URLs, without query secrets."""
    match = MANIFEST_URL.fullmatch(url)
    if match is None:
        raise ValueError("expected an immutable public Blob manifest URL")
    return match.group(1)


def fetch_manifest(url: str) -> dict:
    render_key(url)
    with urlopen(url, timeout=15) as response:
        # Never accept metadata from a different render or endpoint.
        if response.geturl() != url:
            raise ValueError("manifest redirected away from its immutable URL")
        data = response.read(MAX_MANIFEST_BYTES + 1)
    if len(data) > MAX_MANIFEST_BYTES:
        raise ValueError("manifest exceeds metadata size limit")
    return json.loads(data)


def summarize(url: str, manifest: dict) -> dict:
    key = render_key(url)
    if not isinstance(manifest, dict) or manifest.get("schema") != 1:
        raise ValueError("unsupported manifest schema")
    if manifest.get("render_key") != key:
        raise ValueError("manifest render_key does not match immutable URL")

    frames = manifest.get("frames")
    valid_frames = isinstance(frames, list) and all(isinstance(f, dict) for f in frames)
    epochs = manifest.get("epochs")
    valid_epochs = isinstance(epochs, list) and all(isinstance(e, dict) for e in epochs)
    detectors = [frame.get("detector") for frame in frames] if valid_frames else []
    valid_detectors = valid_frames and all(
        type(detector) is int and 1 <= detector <= 6 for detector in detectors
    )
    # If per-pass totals are provided, reject a contradictory frame inventory.
    if valid_epochs and valid_frames and all("n_frames" in e for e in epochs):
        totals = [e["n_frames"] for e in epochs]
        if not all(type(n) is int and n >= 0 for n in totals) or sum(totals) != len(
            frames
        ):
            raise ValueError("per-pass frame totals disagree with frame inventory")

    extras = manifest.get("extras")
    gaia = extras.get("gaia") if isinstance(extras, dict) else None
    has_gaia = None
    if isinstance(extras, dict) and "gaia" in extras:
        if gaia is None:
            has_gaia = False
        elif isinstance(gaia, str) and gaia.strip():
            has_gaia = True
    return {
        "manifest_url": url,
        "render_key": key,
        "frames": len(frames) if valid_frames else None,
        "passes": len(epochs) if valid_epochs else None,
        "bands": len(set(detectors)) if valid_detectors else None,
        "has_gaia": has_gaia,
        "source": manifest.get("source"),
    }


def collect(catalog: dict, fetch: Callable[[str], dict] = fetch_manifest) -> dict:
    objects = catalog.get("objects")
    if not isinstance(objects, list) or not all(
        isinstance(obj, dict) for obj in objects
    ):
        raise TypeError("catalog objects must be a list of objects")
    ids = [obj.get("id") for obj in objects]
    if any(not isinstance(item, str) or not item for item in ids) or len(
        set(ids)
    ) != len(ids):
        raise ValueError(
            "catalog IDs must be nonempty and unique, preserving exact case"
        )

    def one(obj: dict) -> tuple[str, dict]:
        view = obj.get("view")
        url = view.get("manifest_url") if isinstance(view, dict) else None
        unknown = {
            "manifest_url": url,
            "render_key": None,
            "frames": None,
            "passes": None,
            "bands": None,
            "has_gaia": None,
            "source": None,
        }
        try:
            unknown["render_key"] = render_key(url)
            return obj["id"], summarize(url, fetch(url))
        except (OSError, ValueError, TypeError) as error:
            # An unavailable view remains unknown; never replace it with zero.
            unknown["error"] = type(error).__name__
            return obj["id"], unknown

    with ThreadPoolExecutor(max_workers=6) as pool:
        entries = dict(pool.map(one, objects))
    return {
        "schema": 1,
        "generated_at": datetime.now(UTC).isoformat(),
        "catalog_version": catalog.get("version"),
        "objects": entries,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--catalog", type=Path, default=ROOT / "frontend/public/catalog/points.json"
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=ROOT / "frontend/public/catalog/data-availability.json",
    )
    args = parser.parse_args()
    snapshot = collect(json.loads(args.catalog.read_text(encoding="utf-8")))
    args.output.write_text(json.dumps(snapshot, indent=2) + "\n", encoding="utf-8")
    entries = snapshot["objects"].values()
    failures = sum("error" in entry for entry in entries)
    print(f"Wrote {len(snapshot['objects'])} entries; {failures} unavailable manifests")


if __name__ == "__main__":
    main()
