"""Convert locally captured cutouts to the adopted app's demo format, without network calls.

python scripts/pack_capture.py --capture-root D:/spherex_golden --only barnard
"""

import argparse
import csv
import importlib.util
import json
import os
import warnings
from datetime import UTC, datetime
from pathlib import Path
from urllib.parse import urlsplit

from astropy.io import fits

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location(
    "demo_builder", ROOT / "tools/fetch_demo.py"
)
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)
CAPTURE_NAMES = {
    "barnard": "barnard",
    "epsindib": "eps_ind_b",
    "wise0855": "wise0855",
    "rwaur": "rw_aur",
    "rdra": "r_dra",
}


def write_json(path, data):
    part = path.with_suffix(".json.part")
    part.write_text(json.dumps(data, indent=1, allow_nan=False) + "\n", encoding="utf8")
    os.replace(part, path)


def pack(capture_root, demo_root, slug):
    target = next(t for t in builder.TARGETS if t["slug"] == slug)
    source = capture_root / CAPTURE_NAMES[slug]
    with (source / "frames.csv").open(newline="", encoding="utf8") as stream:
        rows = list(csv.DictReader(stream))
    dest = demo_root / slug
    dest.mkdir(parents=True, exist_ok=True)
    files, excluded = [], []
    for row in rows:
        if row["status"] not in ("ok", "skip"):
            excluded.append({"stem": row["stem"], "reason": row["error"]})
            continue
        # Captures are local trusted inputs; nevertheless never follow a path out of the target.
        raw = (source / (row["stem"] + ".fits")).resolve()
        if raw.parent != source.resolve():
            raise ValueError("unsafe capture stem")
        with warnings.catch_warnings():
            warnings.filterwarnings(
                "ignore", message="Card is too long, comment will be truncated."
            )
            body, version = builder.slim_cutout(raw.read_bytes())
        # Stem identifies the exposure exactly; rounded MJD filenames can collide.
        filename = row["stem"] + ".fits.gz"
        part = dest / (filename + ".part")
        part.write_bytes(body)
        os.replace(part, dest / filename)
        with fits.open(raw) as hdus:
            shape = list(hdus["IMAGE"].data.shape)
        files.append(
            {
                "file": filename,
                "uri": urlsplit(row["access_url"]).path.lstrip("/"),
                "mjd": float(row["t_min"]),
                "det": int(row["detector"][-1]),
                "rel": row["collection"].removeprefix("spherex_"),
                "version": version,
                "bytes": len(body),
                "capture_shape": shape,
            }
        )
    if not files:
        raise ValueError(f"no usable captured files for {slug}")
    old_path = dest / "manifest.json"
    old = json.loads(old_path.read_text(encoding="utf8")) if old_path.exists() else {}
    captured_detectors = {f["det"] for f in files}
    retained = [
        f
        for f in old.get("files", [])
        if f["det"] not in captured_detectors and (dest / f["file"]).is_file()
    ]
    files.extend(retained)
    manifest = {
        "name": target["name"],
        "center": builder.propagate(target, 2026.0),
        "fov_arcmin": 7.2,
        "generated": datetime.now(UTC).isoformat(),
        "archive_exposures": len(rows),
        "releases": sorted({f["rel"] for f in files}),
        "files": sorted(files, key=lambda f: f["mjd"]),
        "capture_source": "local raw cutouts, 0.12 degree request",
        "excluded": excluded,
        "captured_files": len(files) - len(retained),
        "retained_other_band_files": len(retained),
    }
    for catalog in ("gaia", "wise"):
        if old.get(catalog) and (dest / old[catalog]).exists():
            manifest[catalog] = old[catalog]
    write_json(old_path, manifest)
    # Drop only files referenced by the superseded manifest, after the new one is durable.
    selected = {f["file"] for f in files}
    for old_file in old.get("files", []):
        path = (dest / old_file["file"]).resolve()
        if path.parent == dest.resolve() and path.name not in selected:
            path.unlink(missing_ok=True)
    index_path = demo_root / "index.json"
    index = (
        json.loads(index_path.read_text(encoding="utf8"))
        if index_path.exists()
        else {"targets": {}}
    )
    index["generated"] = manifest["generated"]
    index["targets"][slug] = {
        k: manifest[k] for k in ("name", "generated", "releases", "fov_arcmin")
    }
    index["targets"][slug]["files"] = len(files)
    write_json(index_path, index)
    print(
        f"{slug}: {len(files)} files, {sum(f['bytes'] for f in files) / 1e6:.2f} MB, {len(excluded)} excluded",
        flush=True,
    )
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--capture-root", type=Path, required=True)
    parser.add_argument("--demo-root", type=Path, default=ROOT / "demo")
    parser.add_argument("--only", choices=list(CAPTURE_NAMES), default="barnard")
    args = parser.parse_args()
    pack(args.capture_root.resolve(strict=True), args.demo_root.resolve(), args.only)


if __name__ == "__main__":
    main()
