"""Local file cache with the two-level layout of docs/PLAN.md 4.4 (q/ pointers, r/ immutable renders).

The Azure Blob version (issue #12) can replace this behind the same three functions.
"""

import json
from pathlib import Path

from ..config import CACHE_DIR


def render_dir(rk: str) -> Path:
    d = CACHE_DIR / "r" / rk
    d.mkdir(parents=True, exist_ok=True)
    return d


def read_pointer(qk: str) -> dict | None:
    p = CACHE_DIR / "q" / f"{qk}.json"
    try:
        return json.loads(p.read_text())
    except (OSError, ValueError):
        return None


def write_pointer(qk: str, rk: str, catalog_version: str) -> None:
    d = CACHE_DIR / "q"
    d.mkdir(parents=True, exist_ok=True)
    tmp = d / f"{qk}.json.tmp"
    tmp.write_text(json.dumps({"render_key": rk, "catalog_version": catalog_version}))
    tmp.replace(d / f"{qk}.json")  # swap after the manifest is written, so readers never see a half render
