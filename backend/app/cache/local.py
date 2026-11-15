"""Local-folder fallback for the render cache (used when STORAGE_ACCOUNT_URL is unset).

Same layout as the Blob container (docs/PLAN.md 4.4): `q/{qk}.json` pointers and `r/{rk}/` renders. main.py serves
the folder at /frames. Every file is written to a temp name and renamed, so readers never see a partial file.
"""

import json
from pathlib import Path
from uuid import uuid4


class LocalCache:
    def __init__(self, root: Path):
        self.root = Path(root)
        # /frames mounts root, so analysis must be a sibling, never underneath it.
        self.analysis_root = self.root.with_name(self.root.name + "-analysis")

    def read_analysis(self, rk: str) -> bytes | None:
        try:
            return (self.analysis_root / "v1" / f"{analysis_key(rk)}.npz").read_bytes()
        except FileNotFoundError:
            return None

    def put_analysis(self, rk: str, data: bytes) -> None:
        _write(self.analysis_root / "v1" / f"{analysis_key(rk)}.npz", data)

    def lookup(self, qk: str) -> dict | None:
        try:
            return json.loads((self.root / "q" / f"{qk}.json").read_text())
        except (OSError, ValueError):
            return None

    def has_render(self, rk: str) -> bool:
        return (self.root / "r" / rk / "manifest.json").is_file()

    def put_render(self, rk: str, manifest: dict, files: dict[str, tuple[bytes, str]]) -> None:
        d = self.root / "r" / rk
        for name, (data, _ctype) in files.items():
            _write(d / safe_name(name), data)
        _write(d / "manifest.json", json.dumps(manifest).encode())  # last

    def point(self, qk: str, rk: str, catalog_version: str) -> None:
        body = json.dumps({"render_key": rk, "catalog_version": catalog_version}).encode()
        _write(self.root / "q" / f"{qk}.json", body)  # swap after the manifest, so readers never see a half render

    def read(self, rk: str, name: str) -> bytes:
        return (self.root / "r" / rk / name).read_bytes()

    def manifest_url(self, rk: str) -> str:
        return f"/frames/r/{rk}/manifest.json"

    def catalog(self) -> dict | None:
        try:
            return json.loads((self.root / "meta" / "catalog.json").read_text())
        except (OSError, ValueError):
            return None

    def get_rows(self, key: str) -> dict | None:
        try:
            return json.loads((self.root / "rows" / f"{safe_name(key)}.json").read_text())
        except (OSError, ValueError):
            return None

    def put_rows(self, key: str, body: dict) -> None:
        _write(self.root / "rows" / f"{safe_name(key)}.json", json.dumps(body).encode())


def _write(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + f".{uuid4().hex}.tmp")
    try:
        tmp.write_bytes(data)
        tmp.replace(path)
    finally:
        tmp.unlink(missing_ok=True)


def analysis_key(rk: str) -> str:
    if len(rk) != 24 or any(c not in "0123456789abcdef" for c in rk):
        raise ValueError("Invalid analysis render key")
    return rk


def safe_name(name: str) -> str:
    """Render files are flat names next to the manifest; anything else is a bug in the caller."""
    if not name or "/" in name or "\\" in name or name.startswith(".") or name == "manifest.json":
        raise ValueError(f"bad render file name: {name!r}")
    return name
