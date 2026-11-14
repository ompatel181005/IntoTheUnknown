"""Retry failed rows in an existing local capture; never query or download full frames.

python scripts/retry_capture.py --capture-root D:/spherex_golden
"""

import argparse
import csv
import io
import json
import os
import re
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from functools import partial
from pathlib import Path

from astropy.io import fits

CENTRES = {
    "barnard": (269.44630, 4.76815),
    "wise0855": (133.75995, -7.24228),
    "eps_ind_b": (331.09656, -56.80064),
    "rw_aur": (76.95609, 30.40113),
    "r_dra": (248.16723, 66.75502),
}
MAX_BYTES = 8 * 1024 * 1024


def validate_cutout(body):
    if not body.startswith(b"SIMPLE"):
        raise ValueError("not a FITS file")
    with fits.open(io.BytesIO(body)) as hdus:
        shape = hdus["IMAGE"].data.shape
        if len(shape) != 2 or not all(0 < n <= 128 for n in shape):
            raise ValueError(f"not a small cutout: {shape}")
        for name in ("FLAGS", "VARIANCE", "ZODI"):
            if hdus[name].data.shape != shape:
                raise ValueError(f"{name} shape mismatch")


def cutout_url(row, target):
    stem = row["stem"]
    if not re.fullmatch(r"level2_[A-Za-z0-9_-]+", stem):
        raise ValueError("unsafe frame stem")
    u = urllib.parse.urlsplit(row["access_url"])
    if (
        u.scheme != "https"
        or u.netloc != "irsa.ipac.caltech.edu"
        or not u.path.startswith("/ibe/data/spherex/")
        or not u.path.endswith(".fits")
        or u.query
        or u.fragment
    ):
        raise ValueError("unexpected archive URL")
    ra, dec = CENTRES[target]
    return row["access_url"] + f"?center={ra},{dec}d&size=0.12"


def recover(row, target, directory, tries):
    row = dict(row)
    url = cutout_url(row, target)
    dest = directory / (row["stem"] + ".fits")
    for attempt in range(tries):
        try:
            if dest.exists():
                body = dest.read_bytes()
            else:
                request = urllib.request.Request(
                    url, headers={"User-Agent": "SPHEREx-capture-recovery/1.0"}
                )
                with urllib.request.urlopen(request, timeout=45) as response:
                    if (
                        urllib.parse.urlsplit(response.geturl()).netloc
                        != "irsa.ipac.caltech.edu"
                    ):
                        raise ValueError("archive redirected outside IRSA")
                    body = response.read(MAX_BYTES + 1)
            if len(body) > MAX_BYTES:
                raise ValueError("cutout exceeds download limit")
            validate_cutout(body)
            if not dest.exists():
                part = dest.with_suffix(".fits.part")
                part.write_bytes(body)
                os.replace(part, dest)
            row.update(status="ok", bytes=str(len(body)), error="")
            return row
        except (OSError, ValueError, KeyError) as exc:
            row.update(
                status="fail", bytes="0", error=f"{type(exc).__name__}: {exc}"[:200]
            )
            if attempt + 1 < tries:
                time.sleep(2 ** (attempt + 1))
    return row


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--capture-root", type=Path, required=True)
    parser.add_argument("--tries", type=int, default=3, choices=range(1, 6))
    args = parser.parse_args()
    root = args.capture_root.resolve(strict=True)
    report = {}
    for target in CENTRES:
        directory = root / target
        manifest = directory / "frames.csv"
        with manifest.open(newline="", encoding="utf8") as stream:
            reader = csv.DictReader(stream)
            fields, rows = reader.fieldnames, list(reader)
        failed = [r for r in rows if r["status"] == "fail"]
        with ThreadPoolExecutor(max_workers=2) as pool:
            recovered = list(
                pool.map(
                    partial(
                        recover, target=target, directory=directory, tries=args.tries
                    ),
                    failed,
                )
            )
        by_stem = {r["stem"]: r for r in recovered}
        rows = [by_stem.get(r["stem"], r) for r in rows]
        if failed:
            part = manifest.with_suffix(".csv.part")
            with part.open("w", newline="", encoding="utf8") as stream:
                writer = csv.DictWriter(stream, fieldnames=fields)
                writer.writeheader()
                writer.writerows(rows)
            os.replace(part, manifest)
        remaining = sum(r["status"] == "fail" for r in rows)
        report[target] = {
            "attempted": len(failed),
            "recovered": len(failed) - remaining,
            "failed": remaining,
        }
        print(target, report[target], flush=True)
    report_path = root / "retry-report.json"
    report_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf8")
    return int(any(r["failed"] for r in report.values()))


if __name__ == "__main__":
    raise SystemExit(main())
