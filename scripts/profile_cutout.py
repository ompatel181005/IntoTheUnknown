"""Profile one real S3 cutout, never a full-frame download or the whole pipeline.

From the repository root, using the backend environment:
  python scripts/profile_cutout.py --target barnard
  python scripts/profile_cutout.py --target barnard --index 1 --repeat 3

Timings are inclusive and must not be summed. Headers/WCS can include lazy remote
reads; science_extract operates only on arrays already materialized by array_read.
This machine's timings do not establish Azure production latency.
"""

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
from app.irsa.fetch import fetch_s3
from app.telemetry import profile_operations


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--target",
        choices=["barnard", "epsindib", "wise0855", "rwaur", "rdra"],
        default="barnard",
    )
    parser.add_argument(
        "--index", type=int, default=0, help="File index in the saved target's manifest"
    )
    parser.add_argument("--repeat", type=int, choices=range(1, 6), default=1)
    args = parser.parse_args()
    manifest = json.loads((ROOT / "demo" / args.target / "manifest.json").read_text())
    if not 0 <= args.index < len(manifest["files"]):
        parser.error("index is outside the target manifest")
    ra, dec = manifest["center"]
    meta = manifest["files"][args.index]
    # URI comes from our checked-in manifest, not an arbitrary user-supplied URL.
    uri = meta["uri"]
    url = (
        uri
        if uri.startswith("https://irsa.ipac.caltech.edu/ibe/data/spherex/")
        else "https://irsa.ipac.caltech.edu/" + uri.lstrip("/")
    )
    if "/ibe/data/spherex/" not in url:
        parser.error("manifest URI does not identify a SPHEREx spectral image")
    failed = False
    for attempt in range(args.repeat):
        with profile_operations() as timings:
            result = fetch_s3(
                {"url": url}, ra, dec, (manifest.get("fov_arcmin", 6) + 1) / 60
            )
        failed |= result is None
        print(
            json.dumps(
                {
                    "target": args.target,
                    "index": args.index,
                    "attempt": attempt + 1,
                    "success": result is not None,
                    "shape": list(result["image"].shape) if result else None,
                    "timings": timings,
                }
            )
        )
    return int(failed)


if __name__ == "__main__":
    raise SystemExit(main())
