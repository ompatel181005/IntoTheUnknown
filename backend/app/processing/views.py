"""View jobs: find frames (demo pack or live IRSA), stack per epoch, write the manifest and arrays."""

import concurrent.futures as cf
import hashlib
import json
import logging
import threading
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path

import numpy as np
from astropy.coordinates import SkyCoord
from astropy.time import Time

from .. import config
from ..cache import local
from ..irsa import fetch
from ..models import ViewRequest
from . import stack

log = logging.getLogger("views")

BAND_DETECTORS = {
    "B1": {1},
    "B2": {2},
    "B3": {3},
    "B4": {4},
    "B5": {5},
    "B6": {6},
    "B1-B2": {1, 2},
    "B1-B3": {1, 2, 3},
    "all": {1, 2, 3, 4, 5, 6},
    "auto": {1, 2, 3, 4, 5, 6},
}
PIX_SR = (stack.PIX_ARCSEC / 206264.806) ** 2  # pixel solid angle
UJY_PER_MJYSR_PIX = PIX_SR * 1e12  # MJy/sr x sr -> uJy


class ViewError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass
class Job:
    qk: str
    req: ViewRequest
    status: str = "queued"
    done: int = 0
    total: int = 0
    manifest_url: str | None = None
    error: tuple[str, str] | None = None
    from_cache: bool = False
    # Kept in memory for /spectrum and /lightcurve.
    epochs: list[list[dict]] = field(default_factory=list)
    shape: tuple[int, int] = (0, 0)


JOBS: dict[str, Job] = {}
LOCK = threading.Lock()
POOL = cf.ThreadPoolExecutor(max_workers=config.MAX_RENDER_JOBS)


def query_key(req: ViewRequest) -> str:
    key = f"q1|{req.ra:.4f}|{req.dec:+.4f}|{req.fov_arcmin}|{req.band}"
    if req.source != "auto":
        key += f"|{req.source}"
    return hashlib.sha256(key.encode()).hexdigest()[:20]


# ---------------------------------------------------------------- frame sources


def _demo_pack(req: ViewRequest) -> tuple[Path, dict] | None:
    """The demo pack folder whose centre is within 1 arcmin and whose cutouts cover the requested FOV."""
    want = SkyCoord(req.ra, req.dec, unit="deg")
    for man in sorted(config.DEMO_DIR.glob("*/manifest.json")):
        try:
            m = json.loads(man.read_text())
        except (OSError, ValueError):
            continue
        c = m.get("center")
        if not c or m.get("fov_arcmin", 0) < req.fov_arcmin:
            continue
        if want.separation(SkyCoord(c[0], c[1], unit="deg")).arcmin < 1.0:
            return man.parent, m
    return None


def demo_frames(req: ViewRequest, job: Job) -> tuple[list[dict], dict] | None:
    hit = _demo_pack(req)
    if not hit:
        return None
    folder, m = hit
    dets = BAND_DETECTORS[req.band]
    metas = [f for f in m.get("files", []) if int(f.get("det", 0)) in dets]
    job.status, job.total, job.done = "fetch", len(metas), 0
    out = []
    for f in metas:
        r = fetch.load_demo(folder / f["file"], req.ra, req.dec, f)
        if r is not None:
            out.append(r)
        job.done += 1
    origin = {
        "kind": "saved",
        "label": "Saved SPHEREx cutouts bundled with the app",
        "fetched": m.get("generated"),
        "files": len(m.get("files", [])),
        "archive_exposures": m.get("archive_exposures"),
    }
    return out, origin


def live_frames(req: ViewRequest, job: Job) -> list[dict]:
    from ..irsa import query  # astroquery import is slow; only for live views

    job.status = "query"
    try:
        try:
            colls = query.discover_collections()
        except Exception:
            colls = ["spherex_dr1", "spherex_qr3"]  # list_collections is TAP-backed (DECISIONS 2026-11-14)
        try:
            rows = query.query_frames_sia(req.ra, req.dec, colls)
        except Exception:
            rows = query.query_frames_tap(req.ra, req.dec)
    except Exception as e:  # both SIA and TAP failed
        log.warning("IRSA query failed: %s", e)
        raise ViewError(
            "IRSA_DOWN",
            "NASA's SPHEREx archive (IRSA) is not answering right now. The five test targets still work from "
            "cached data. Try this position again in a few minutes.",
        ) from e
    dets = BAND_DETECTORS[req.band]
    rows = [r for r in rows if r["band"].startswith("SPHEREx-D") and int(r["band"][-1]) in dets]
    if len(rows) > config.MAX_FRAMES_PER_VIEW:
        idx = np.linspace(0, len(rows) - 1, config.MAX_FRAMES_PER_VIEW).round().astype(int)
        rows = [rows[i] for i in idx]
    job.status, job.total, job.done = "fetch", len(rows), 0

    def progress(done, total):
        job.done, job.total = done, total

    size = (req.fov_arcmin + 1) / 60  # degrees; capped by the FOV enum
    frames = fetch.fetch_all(rows, req.ra, req.dec, size, workers=config.CUTOUT_MAX_WORKERS, on_progress=progress)
    if rows and not frames:
        raise ViewError(
            "IRSA_DOWN", "IRSA listed frames for this spot but every cutout download failed. Try again soon."
        )
    return frames


# ---------------------------------------------------------------- pipeline


def _label(mjd: float) -> str:
    return Time(mjd, format="mjd").to_datetime().strftime("%Y-%m")


def _iso(mjd: float) -> str:
    return Time(mjd, format="mjd").to_datetime(timezone=UTC).isoformat(timespec="seconds")


def _flag_counts(ep: list[dict]) -> dict[str, int]:
    """Mean count per frame of each masked flag inside the cutout (names parsed from the header)."""
    totals: dict[str, float] = {}
    for f in ep:
        for name, bit in f["flag_names"].items():
            if name in stack.KEEP:
                continue
            n = int(((f["flags"] & (1 << bit)) != 0).sum())
            if n:
                totals[name] = totals.get(name, 0) + n
    return {k: round(v / len(ep)) for k, v in sorted(totals.items(), key=lambda kv: -kv[1]) if v / len(ep) >= 0.5}


def build(job: Job) -> None:
    req = job.req
    saved = demo_frames(req, job) if req.source != "live" else None
    if saved is None and req.source == "saved":
        raise ViewError(
            "NOT_SAVED",
            "Saved cutouts exist only for the five test targets at fields of view up to 8 arcmin. "
            "Switch the data source to Live archive or Auto.",
        )
    if saved is not None:
        frames, origin = saved
        source, min_frames = "golden", config.MIN_EPOCH_FRAMES_DEMO
    else:
        frames = live_frames(req, job)
        source, min_frames = "irsa", config.MIN_EPOCH_FRAMES_LIVE
        origin = {
            "kind": "live",
            "label": "Live from NASA/IPAC IRSA",
            "fetched": datetime.now(UTC).isoformat(timespec="seconds"),
            "files": len(frames),
            "archive_exposures": None,
        }

    w, shape = stack.common_grid(req.ra, req.dec, req.fov_arcmin)
    job.status, job.total, job.done = "stack", len(frames), 0
    for f in frames:
        f["_grid"] = stack.to_grid(f, w, shape)
        job.done += 1
    epochs = [ep for ep in stack.group_epochs(frames) if len(ep) >= min_frames]

    job.status = "render"
    collections = sorted({f["collection"] for f in frames})
    catalog_version = "+".join(collections) or "none"
    rk = hashlib.sha256(
        f"{config.PIPELINE_VERSION}|{job.qk}|{','.join(sorted(f['obs'] for ep in epochs for f in ep))}".encode()
    ).hexdigest()[:24]
    out = local.render_dir(rk)

    stacks: list[np.ndarray] = []
    info: dict = {"channels": [], "bandpass_matched": False}
    if epochs:
        stacks, info = stack.stack_epochs(epochs, w, shape)
    stretch = (
        stack.shared_asinh(stacks)
        if stacks and any(np.isfinite(s).any() for s in stacks)
        else {"kind": "asinh", "vmin": 0.0, "vmax": 1.0, "beta": 1.0}
    )

    epoch_rows = []
    for i, (ep, img) in enumerate(zip(epochs, stacks)):
        img.astype("<f4").tofile(out / f"e{i}.f32")
        nan_frac = np.mean([~np.isfinite(f["_grid"][0]) for f in ep], axis=0)
        (nan_frac > 0.5).astype("u1").tofile(out / f"e{i}.mask.u8")
        mjds = [f["t_mjd"] for f in ep]
        lams = [f["lam_um"] for f in ep]
        epoch_rows.append(
            {
                "i": i,
                "label": _label(float(np.mean(mjds))),
                "t_start": _iso(min(mjds)),
                "t_end": _iso(max(mjds)),
                "t_mean_mjd": float(np.mean(mjds)),
                "n_frames": len(ep),
                "detectors": sorted({f["detector"] for f in ep}),
                "lambda_um": [round(min(lams), 3), round(max(lams), 3)],
                "channels": len(info["channels"]),
                "flagged_px": _flag_counts(ep),
                "astrom_resid_px": None,
                "phot_scale": 1.0,
                "image": f"e{i}.f32",
                "mask": f"e{i}.mask.u8",
                "png": None,
            }
        )

    hdr = w.to_header()
    manifest = {
        "schema": 1,
        "render_key": rk,
        "source": source,
        "pipeline_version": config.PIPELINE_VERSION,
        "created_at": datetime.now(UTC).isoformat(timespec="seconds"),
        "query": {"ra": req.ra, "dec": req.dec, "fov_arcmin": req.fov_arcmin, "band": req.band},
        "grid": {
            "nx": shape[1],
            "ny": shape[0],
            "pix_arcsec": stack.PIX_ARCSEC,
            "wcs": {
                k: hdr[k] for k in ("CTYPE1", "CTYPE2", "CRVAL1", "CRVAL2", "CRPIX1", "CRPIX2", "CDELT1", "CDELT2")
            },
        },
        "catalog": {"version": catalog_version, "collections": collections},
        "origin": origin,
        "stretch": stretch,
        "bandpass_matched": info["bandpass_matched"],
        "epochs": epoch_rows,
        "frames": [
            {
                "obs": f["obs"],
                "t_mjd": f["t_mjd"],
                "detector": f["detector"],
                "lambda_um": round(f["lam_um"], 4),
                "epoch": i,
                "collection": f["collection"],
            }
            for i, ep in enumerate(epochs)
            for f in ep
        ],
        "extras": {"gaia": None, "lightcurve": None, "cube": None},
    }
    (out / "manifest.json").write_text(json.dumps(manifest))
    local.write_pointer(job.qk, rk, catalog_version)
    job.epochs, job.shape = epochs, shape
    job.manifest_url = f"/frames/r/{rk}/manifest.json"
    job.status = "ready"


def _run(job: Job) -> None:
    try:
        build(job)
    except ViewError as e:
        job.status, job.error = "error", (e.code, e.message)
    except Exception as e:
        log.exception("view %s failed", job.qk)
        job.status, job.error = "error", ("PIPELINE_ERROR", f"Building this view failed: {e}")


def create(req: ViewRequest) -> Job:
    qk = query_key(req)
    with LOCK:
        job = JOBS.get(qk)
        if job and job.status != "error":
            return job
        job = Job(qk=qk, req=req)
        ptr = local.read_pointer(qk)
        if ptr and (config.CACHE_DIR / "r" / ptr["render_key"] / "manifest.json").exists():
            job.status, job.from_cache = "ready", True
            job.manifest_url = f"/frames/r/{ptr['render_key']}/manifest.json"
        JOBS[qk] = job
    if job.status != "ready":
        POOL.submit(_run, job)
    return job


def ensure_frames(job: Job) -> None:
    """Rebuild the in-memory frames after a restart (the manifest came from the cache)."""
    if not job.epochs:
        build(job)


# ---------------------------------------------------------------- measurements


def spectrum(job: Job, x: int, y: int, epoch: int) -> list[dict]:
    ensure_frames(job)
    if not (0 <= epoch < len(job.epochs)):
        return []
    pts = []
    for f in job.epochs[epoch]:
        im, var = f["_grid"]
        if not (0 <= y < im.shape[0] and 0 <= x < im.shape[1]):
            continue
        v = float(im[y, x])
        e = float(np.sqrt(var[y, x])) if f.get("var") is not None and np.isfinite(var[y, x]) else None
        pts.append(
            {
                "lambda_um": f["lam_um"],
                "bw_um": f["bw_um"],
                "flux_mjysr": v if np.isfinite(v) else None,
                "err": e,
                "t_mjd": f["t_mjd"],
                "detector": f["detector"],
                "flagged": not np.isfinite(v),
            }
        )
    return sorted(pts, key=lambda p: p["lambda_um"])


def lightcurve(job: Job, x: float, y: float, r_px: float = 2.0) -> list[dict]:
    """Forced aperture photometry on every frame (PLAN 5.9): r = r_px, background annulus 4-7 px."""
    ensure_frames(job)
    ny, nx = job.shape
    yy, xx = np.mgrid[0:ny, 0:nx]
    d = np.hypot(xx - x, yy - y)
    ap, ann = d <= r_px, (d >= 4) & (d <= 7)
    pts = []
    for ep in job.epochs:
        for f in ep:
            im = f["_grid"][0]
            bkg_px = im[ann & np.isfinite(im)]
            if bkg_px.size < 5:
                continue
            bkg = float(np.median(bkg_px))
            vals = im[ap]
            flagged = bool((~np.isfinite(vals)).any())
            npix = int(np.isfinite(vals).sum())
            if npix == 0:
                continue
            flux = (float(np.nansum(vals)) - npix * bkg) * UJY_PER_MJYSR_PIX
            err = float(np.std(bkg_px)) * np.sqrt(npix) * UJY_PER_MJYSR_PIX
            pts.append(
                {"t_mjd": f["t_mjd"], "lambda_um": f["lam_um"], "flux_ujy": flux, "err": err, "flagged": flagged}
            )
    return sorted(pts, key=lambda p: p["t_mjd"])
