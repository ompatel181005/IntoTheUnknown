"""Lossless, pickle-free measurement inputs for one exact immutable render.

These files live in private storage, independently of the public image schema.
Aligned grids are saved after astrometric alignment, not reconstructed on restore.
"""

import io
import json
import zipfile

import numpy as np
from astropy.io import fits

SCHEMA = 1
MAX_BYTES = 128 * 1024 * 1024
SCALARS = ("obs", "t_mjd", "lam_um", "bw_um", "detector", "collection", "flag_names")
ARRAYS = ("image", "var", "flags")


def encode(rk: str, epochs: list[list[dict]], shape: tuple[int, int]) -> bytes:
    arrays = {}
    groups = []
    for ep in epochs:
        group = []
        for f in ep:
            prefix = f"f{sum(map(len, groups)) + len(group)}"
            row = {key: f[key] for key in SCALARS}
            header = f["wcs_header"]
            row["wcs_header"] = header.tostring() if isinstance(header, fits.Header) else fits.Header(header).tostring()
            row["prefix"] = prefix
            row["arrays"] = [key for key in ARRAYS if f.get(key) is not None]
            for key in row["arrays"]:
                arrays[f"{prefix}_{key}"] = f[key]
            for i, grid in enumerate(f["_grid"]):
                arrays[f"{prefix}_grid{i}"] = grid
            group.append(row)
        groups.append(group)
    meta = {"schema": SCHEMA, "render_key": rk, "shape": shape, "epochs": groups}
    arrays["metadata"] = np.frombuffer(json.dumps(meta).encode(), dtype="u1")
    if sum(a.nbytes for a in arrays.values()) > MAX_BYTES:
        raise ValueError("Measurement inputs exceed cache size limit")
    output = io.BytesIO()
    np.savez_compressed(output, **arrays)
    return output.getvalue()


def decode(data: bytes, rk: str, manifest: dict) -> tuple[list[list[dict]], tuple[int, int]]:
    if len(data) > MAX_BYTES:
        raise ValueError("Analysis cache exceeds size limit")
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        if len(archive.infolist()) > 2000 or sum(i.file_size for i in archive.infolist()) > MAX_BYTES:
            raise ValueError("Analysis cache expands beyond size limit")
    with np.load(io.BytesIO(data), allow_pickle=False) as archive:
        meta = json.loads(archive["metadata"].tobytes())
        shape = (manifest["grid"]["ny"], manifest["grid"]["nx"])
        if meta["schema"] != SCHEMA or meta["render_key"] != rk or tuple(meta["shape"]) != shape:
            raise ValueError("Analysis cache does not match this render")
        groups = []
        for ep in meta["epochs"]:
            group = []
            for row in ep:
                prefix = row["prefix"]
                f = {key: row[key] for key in SCALARS}
                f["wcs_header"] = fits.Header.fromstring(row["wcs_header"])
                for key in ARRAYS:
                    f[key] = archive[f"{prefix}_{key}"] if key in row["arrays"] else None
                f["_grid"] = tuple(archive[f"{prefix}_grid{i}"] for i in (0, 1))
                values = [v for key in ARRAYS if (v := f[key]) is not None] + list(f["_grid"])
                if any(v.ndim != 2 or v.dtype.kind not in "fiu" for v in values):
                    raise ValueError("Invalid measurement array")
                if any(v.shape != shape for v in f["_grid"]):
                    raise ValueError("Invalid measurement grid")
                group.append(f)
            groups.append(group)
    frames = [
        {
            "obs": f["obs"],
            "t_mjd": f["t_mjd"],
            "detector": f["detector"],
            "lambda_um": round(f["lam_um"], 4),
            "epoch": i,
            "collection": f["collection"],
        }
        for i, ep in enumerate(groups)
        for f in ep
    ]
    if frames != manifest["frames"] or [len(ep) for ep in groups] != [e["n_frames"] for e in manifest["epochs"]]:
        raise ValueError("Analysis frame list differs from the image")
    return groups, shape
