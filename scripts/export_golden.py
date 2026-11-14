#!/usr/bin/env python3
"""Bake the 5 preset views into frontend/public/golden/<id>/ (issue #18, PLAN 4.4 "Golden layer").

Runs the real backend pipeline in-process on the demo pack (no network) and copies each view's manifest and
arrays. The frontend loads presets from there first, so they work with the API, IRSA or Blob down.

    cd backend && pip install -e ".[dev]" && cd ..
    python scripts/export_golden.py            # rerun after tools/fetch_demo.py or a pipeline change
"""

import os
import shutil
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "frontend" / "public" / "golden"
os.environ["CACHE_DIR"] = tempfile.mkdtemp(prefix="golden-")  # fresh renders, before app.config is imported
sys.path.insert(0, str(ROOT / "backend"))

from app.models import ViewRequest
from app.processing import views
from app.targets import TARGETS


def export(t) -> int:
    job = views.create(ViewRequest(ra=t.ra, dec=t.dec, fov_arcmin=t.fov_arcmin, band=t.band))
    t0 = time.time()
    while job.status not in ("ready", "error"):
        if time.time() - t0 > 300:
            raise TimeoutError(f"{t.id}: view not ready after 300 s")
        time.sleep(0.2)
    if job.status == "error":
        raise RuntimeError(f"{t.id}: {job.error}")
    src = Path(os.environ["CACHE_DIR"]) / job.manifest_url.removeprefix("/frames/")
    dest = OUT / t.id
    shutil.rmtree(dest, ignore_errors=True)
    shutil.copytree(src.parent, dest)
    return sum(f.stat().st_size for f in dest.iterdir())


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    total, failed = 0, []
    for t in TARGETS:
        try:
            n = export(t)
        except Exception as e:  # report and keep going: one bad target must not block the others
            failed.append(t.id)
            print(f"{t.id:10s} FAILED: {e}")
            continue
        total += n
        print(f"{t.id:10s} {n / 1024:7.1f} KB  -> {(OUT / t.id).relative_to(ROOT)}")
    print(f"total      {total / 1024:7.1f} KB")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
