"""View jobs: find frames (demo pack or live IRSA), stack per epoch, write the manifest and arrays."""

import concurrent.futures as cf
import contextvars
import json
import logging
import threading
import time
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path

import numpy as np
from astropy.coordinates import SkyCoord
from astropy.time import Time

from .. import config
from ..cache import FrameCache, LocalCache, get_cache, render_key
from ..cache import query_key as sky_query_key
from ..irsa import fetch
from ..models import ViewRequest
from ..telemetry import operation, record_cache_hit
from . import align, analysis_cache, photometry, stack
from . import gaia as gaia_dr3

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
    rk: str | None = None  # render key, and the cache that holds that render
    cache: FrameCache | None = None
    error: tuple[str, str] | None = None
    from_cache: bool = False
    # Kept in memory for /spectrum and /lightcurve.
    epochs: list[list[dict]] = field(default_factory=list)
    shape: tuple[int, int] = (0, 0)
    frames_lock: threading.Lock = field(default_factory=threading.Lock, repr=False)


JOBS: dict[str, Job] = {}
LOCK = threading.Lock()
POOL = cf.ThreadPoolExecutor(max_workers=config.MAX_RENDER_JOBS)
ADMISSION = threading.BoundedSemaphore(config.MAX_RENDER_JOBS + config.MAX_QUEUED_JOBS)
OCTET = "application/octet-stream"


def query_key(req: ViewRequest) -> str:
    """The view id for a request (scripts/validate_integrated.py uses this too). Rules live in cache.blob."""
    return sky_query_key(req.ra, req.dec, req.fov_arcmin, req.band, req.source)


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


def demo_frames(req: ViewRequest, job: Job) -> tuple[list[dict], dict, list[dict]] | None:
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
    return out, origin, align.load_gaia_csv(folder / "gaia.csv")


# IRSA's frame list depends only on position (SIA is a 1 arcsec point query; the band filter runs after), so one
# list per position serves every band and FOV there (#96). It is kept in the cache and reused when fresh, and while
# IRSA is down, so changing band or FOV at a spot someone has viewed never waits on, or fails with, the archive.
ROWS_TTL_S = 6 * 3600  # the watcher's daily refresh re-asks IRSA regardless (max_age_s=0)
IRSA_COOLDOWN_S = 120  # after a failed query, skip IRSA for this long instead of spending another ~30 s on it
_irsa = {"failed_at": None}
IRSA_DOWN_MESSAGE = (
    "NASA's SPHEREx archive (IRSA) is not answering right now. The five test targets still work from "
    "cached data. Try this position again in a few minutes."
)


def rows_key(req: ViewRequest) -> str:
    return f"{req.ra:.4f}{req.dec:+.4f}"  # the same 4-decimal bucket as the query key


def irsa_recently_down() -> bool:
    failed = _irsa["failed_at"]
    return failed is not None and time.monotonic() - failed < IRSA_COOLDOWN_S


def cached_rows(req: ViewRequest, cache: FrameCache | None = None) -> dict | None:
    """{"at": unix seconds, "rows": [...]} saved from IRSA for this position, or None."""
    get = getattr(cache or get_cache(), "get_rows", None)  # test doubles may not implement it
    try:
        body = get(rows_key(req)) if get else None
    except Exception as e:
        log.warning("frame list for %s unreadable: %s", rows_key(req), e)
        return None
    ok = isinstance(body, dict) and isinstance(body.get("rows"), list) and isinstance(body.get("at"), (int, float))
    return body if ok else None


def _query_irsa(req: ViewRequest) -> list[dict]:
    from ..irsa import query  # astroquery import is slow; only for live views

    try:
        return query.query_frames_sia(req.ra, req.dec, query.collections())
    except Exception:
        return query.query_frames_tap(req.ra, req.dec)


def archive_rows(req: ViewRequest, max_age_s: float | None = None, allow_stale: bool = True) -> list[dict]:
    """Every detector's frames at this position: the saved list when fresh, else IRSA (then saved), else the
    saved list of any age while IRSA is down. Raises IRSA_DOWN when IRSA fails and nothing usable is saved."""
    max_age_s = ROWS_TTL_S if max_age_s is None else max_age_s
    cache = get_cache()
    saved = cached_rows(req, cache)
    if saved and time.time() - saved["at"] <= max_age_s:
        return saved["rows"]
    if not irsa_recently_down():
        try:
            rows = [{k: v for k, v in r.items() if k != "_rank"} for r in _query_irsa(req)]
        except Exception as e:  # both SIA and TAP failed
            _irsa["failed_at"] = time.monotonic()
            log.warning("IRSA query failed: %s", e)
        else:
            _irsa["failed_at"] = None
            put = getattr(cache, "put_rows", None)
            if put and rows:  # an empty answer is not worth keeping over a real list
                try:
                    put(rows_key(req), {"at": time.time(), "rows": rows})
                except Exception as e:
                    log.warning("could not save frame list for %s: %s", rows_key(req), e)
            return rows
    if saved and allow_stale:
        log.info("IRSA unavailable; using the frame list saved %.0f min ago", (time.time() - saved["at"]) / 60)
        return saved["rows"]
    raise ViewError("IRSA_DOWN", IRSA_DOWN_MESSAGE)


def live_rows(req: ViewRequest, max_age_s: float | None = None, allow_stale: bool = True) -> list[dict]:
    """IRSA's frame list for this position and band (no downloads)."""
    rows = archive_rows(req, max_age_s, allow_stale)
    dets = BAND_DETECTORS[req.band]
    return [r for r in rows if r["band"].startswith("SPHEREx-D") and int(r["band"][-1]) in dets]


def doomed_live_view(req: ViewRequest, cache: FrameCache) -> bool:
    """True when this view would need IRSA, IRSA just failed, and no frame list is saved: fail now, not in a slot."""
    if req.source == "saved" or not irsa_recently_down():
        return False
    if req.source == "auto" and _demo_pack(req) is not None:
        return False
    return cached_rows(req, cache) is None


def live_frames(req: ViewRequest, job: Job) -> list[dict]:
    job.status = "query"
    rows = live_rows(req)
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


def select_epochs(groups: list[list[dict]], minimum: int, saved: bool) -> list[list[dict]]:
    """Apply the science floor to rich captures and retain the legacy sparse-demo fallback."""
    if saved and sum(len(ep) >= config.MIN_EPOCH_FRAMES_LIVE for ep in groups) >= 2:
        minimum = max(minimum, config.MIN_EPOCH_FRAMES_LIVE)
    selected = [ep for ep in groups if len(ep) >= minimum]
    if len(selected) != len(groups):
        log.info("Dropped %d underfilled epochs (minimum %d frames)", len(groups) - len(selected), minimum)
    return selected


@operation("pipeline", "build", internal=True)
def build(job: Job, expected_render: str | None = None, expected_cache: FrameCache | None = None) -> None:
    req = job.req
    saved = demo_frames(req, job) if req.source != "live" else None
    if saved is None and req.source == "saved":
        raise ViewError(
            "NOT_SAVED",
            "Saved cutouts exist only for the five test targets at fields of view up to 8 arcmin. "
            "Switch the data source to Live archive or Auto.",
        )
    if saved is not None:
        frames, origin, gaia = saved
        gaia_cat = gaia_dr3.catalog_from_rows(gaia)
        source, min_frames = "golden", config.MIN_EPOCH_FRAMES_DEMO
    else:
        # Gaia can take 30 s or more to answer (or to time out), so it runs beside the cutout download.
        side = cf.ThreadPoolExecutor(max_workers=1)
        try:
            gaia_job = side.submit(
                contextvars.copy_context().run, gaia_dr3.live_catalog, req.ra, req.dec, req.fov_arcmin
            )
            frames = live_frames(req, job)
            gaia_cat = gaia_job.result()  # None when Gaia is down
        finally:
            side.shutdown(wait=False)  # an IRSA error must not wait for Gaia
        gaia = []  # live Gaia query lands with #8; until then live views report astrom_resid_px: null
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
    groups = stack.group_epochs(frames)
    # Dense captured demos follow the same ten-frame science gate as live data. Keeping a
    # thin tail can reduce the channel intersection and bias the whole sequence. Legacy
    # sparse packs retain the small fallback until richer captures are available.
    epochs = select_epochs(groups, min_frames, saved is not None)

    job.status = "render"
    collections = sorted({f["collection"] for f in frames})
    catalog_version = "+".join(collections) or "none"
    rk = render_key(config.PIPELINE_VERSION, job.qk, [f["obs"] for ep in epochs for f in ep])
    if expected_render is not None and rk != expected_render:
        raise ViewError(
            "MEASUREMENTS_UNAVAILABLE",
            "The archive frame set has changed since this image was prepared. Its original measurement inputs "
            "are unavailable. Try a Saved test target or reopen an updated prepared view.",
        )
    # Always render: alignment can re-grid an epoch, and /spectrum and /lightcurve read those grids from job.epochs.
    manifest, files = _render(job, rk, epochs, w, shape, source, origin, collections, catalog_version, gaia, gaia_cat)
    cache = get_cache()
    if expected_render is not None:
        # Recovery must verify the original public image before any storage fallback.
        # A new local render with the same frame IDs cannot stand in for an unreadable Blob image.
        try:
            _verify_render(expected_cache or cache, rk, manifest, files)
        except Exception as error:
            raise ViewError(
                "MEASUREMENTS_UNAVAILABLE",
                "The original cached image could not be matched to these inputs. "
                "Its image is still available; try measurements again later.",
            ) from error
    try:
        _store(cache, job.qk, rk, manifest, files, catalog_version, update_pointer=expected_render is None)
    except ViewError:
        raise
    except Exception:
        if isinstance(cache, LocalCache):
            raise
        # Blob trouble must not fail a finished view: keep it on local disk (served at /frames) until a restart.
        log.exception("Blob cache write failed for view %s; keeping the render on local disk", job.qk)
        cache = LocalCache(config.CACHE_DIR)
        _store(cache, job.qk, rk, manifest, files, catalog_version, update_pointer=expected_render is None)
    try:
        cache.put_analysis(rk, analysis_cache.encode(rk, epochs, shape))
    except Exception:
        # An optional analysis write must not discard a completed image.
        log.exception("Could not persist measurement inputs for render %s", rk)
    job.epochs, job.shape = epochs, shape
    job.rk, job.cache = rk, cache
    job.manifest_url = cache.manifest_url(rk)
    job.status = "ready"


def _verify_render(cache: FrameCache, rk: str, manifest: dict, files: dict) -> None:
    previous = json.loads(cache.read(rk, "manifest.json"))
    same_frames = previous["frames"] == manifest["frames"]
    same_images = all(cache.read(rk, name) == data for name, (data, _) in files.items() if name.endswith(".f32"))
    if not same_frames or not same_images:
        raise ViewError(
            "MEASUREMENTS_UNAVAILABLE", "The cached image differs from the rebuilt inputs. Reopen an updated view."
        )


def _store(
    cache: FrameCache, qk: str, rk: str, manifest: dict, files: dict, catalog_version: str, update_pointer: bool = True
) -> None:
    if cache.has_render(rk):
        _verify_render(cache, rk, manifest, files)
    else:  # r/ is write-once
        cache.put_render(rk, manifest, files)
    if update_pointer:  # legacy recovery must never roll back a pointer refreshed by the watcher
        cache.point(qk, rk, catalog_version)


def _render(
    job: Job, rk: str, epochs, w, shape, source, origin, collections, catalog_version, gaia, gaia_cat
) -> tuple[dict, dict]:
    """Stack each epoch and return (manifest, files) for the cache. Nothing touches storage here."""
    req = job.req
    files: dict[str, tuple[bytes, str]] = {}
    stacks: list[np.ndarray] = []
    info: dict = {"channels": [], "bandpass_matched": False}
    astrom: list[dict | None] = []
    if epochs:
        stacks, info, astrom = align.align_epochs(epochs, w, shape, gaia)
    stretch = (
        stack.shared_asinh(stacks)
        if stacks and any(np.isfinite(s).any() for s in stacks)
        else {"kind": "asinh", "vmin": 0.0, "vmax": 1.0, "beta": 1.0}
    )
    # Field-star ratios only measure calibration when every epoch covers the same channels; across different
    # bandpasses they measure colour, so unmatched stacks keep 1.0 (PLAN 5.5).
    scales = stack.phot_scales(stacks) if info["bandpass_matched"] else [1.0] * len(stacks)

    epoch_rows = []
    for i, (ep, img) in enumerate(zip(epochs, stacks)):
        files[f"e{i}.f32"] = (img.astype("<f4").tobytes(), OCTET)
        nan_frac = np.mean([~np.isfinite(f["_grid"][0]) for f in ep], axis=0)
        files[f"e{i}.mask.u8"] = ((nan_frac > 0.5).astype("u1").tobytes(), OCTET)
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
                "astrom_resid_px": round(astrom[i]["resid_px"], 4) if astrom[i] else None,
                "astrom_offset_px": [round(astrom[i]["dx"], 4), round(astrom[i]["dy"], 4)] if astrom[i] else None,
                "astrom_stars": astrom[i]["n_stars"] if astrom[i] else 0,
                "phot_scale": round(scales[i], 4),
                "image": f"e{i}.f32",
                "mask": f"e{i}.mask.u8",
                "png": None,
            }
        )

    # Gaia overlay (#29): where each Gaia star should be in every epoch. Absent, never fatal, when Gaia is.
    overlay = None
    if gaia_cat is not None and len(gaia_cat) and stacks:
        try:
            overlay = gaia_dr3.overlay(gaia_cat, [r["t_mean_mjd"] for r in epoch_rows], stacks, w)
        except Exception:
            log.exception("Gaia overlay failed for view %s", job.qk)
    if overlay is not None:
        files["gaia.json"] = (json.dumps(overlay).encode(), "application/json")

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
        "extras": {"gaia": "gaia.json" if overlay else None, "lightcurve": None, "cube": None},
    }
    return manifest, files


def _run(job: Job) -> None:
    try:
        build(job)
    except ViewError as e:
        job.status, job.error = "error", (e.code, e.message)
    except Exception as e:
        log.exception("view %s failed", job.qk)
        job.status, job.error = "error", ("PIPELINE_ERROR", f"Building this view failed: {e}")


def _execute(job: Job, admission: threading.BoundedSemaphore) -> None:
    """Release exactly this admission even if the renderer fails or exits early."""
    try:
        _run(job)
    finally:
        with LOCK:
            if job.status not in ("ready", "error"):
                job.status, job.error = "error", ("PIPELINE_ERROR", "The renderer ended without a completed view.")
        admission.release()


def _existing(qk: str) -> Job | None:
    """Called only under LOCK; terminal failures may be retried."""
    job = JOBS.get(qk)
    if job and job.status != "error":
        record_cache_hit(job.status == "ready", "memory" if job.status == "ready" else "pending")
        return job
    return None


def create(req: ViewRequest) -> Job:
    qk = query_key(req)
    with LOCK:
        if job := _existing(qk):
            return job

    # Blob reads and SDK initialization can be slow. They must never hold the
    # global jobs lock or consume render capacity. Recheck dedupe after this I/O.
    cache = get_cache()
    ptr = cache.lookup(qk)
    rk = ptr.get("render_key") if isinstance(ptr, dict) else None
    manifest_url = cache.manifest_url(rk) if rk else None
    if not rk and doomed_live_view(req, cache):
        raise ViewError("IRSA_DOWN", IRSA_DOWN_MESSAGE)
    with LOCK:
        if job := _existing(qk):
            return job
        job = Job(qk=qk, req=req)
        admission = None
        if rk:
            job.status, job.from_cache = "ready", True
            job.rk, job.cache = rk, cache
            job.manifest_url = manifest_url
        else:
            admission = ADMISSION  # capture it so tests/reconfiguration cannot release a different limiter
            if not admission.acquire(blocking=False):
                raise ViewError("QUEUE_FULL", "The render queue is full. Please try again shortly.")
        JOBS[qk] = job
        record_cache_hit(
            job.from_cache, ("blob" if config.STORAGE_ACCOUNT_URL else "local") if job.from_cache else "miss"
        )
    if admission is not None:
        try:
            POOL.submit(contextvars.copy_context().run, _execute, job, admission)
        except Exception as error:
            with LOCK:
                job.status, job.error = "error", ("PIPELINE_ERROR", "The render could not be queued. Try again.")
            admission.release()
            raise ViewError(*job.error) from error
    return job


def ensure_frames(job: Job) -> None:
    """Restore exact aligned inputs after restart; migrate legacy renders once, under admission control."""
    with job.frames_lock:
        if job.epochs:
            return
        if job.rk and job.cache is not None:
            try:
                data = job.cache.read_analysis(job.rk)
                if data is not None:
                    manifest = json.loads(job.cache.read(job.rk, "manifest.json"))
                    job.epochs, job.shape = analysis_cache.decode(data, job.rk, manifest)
                    return
            except Exception:
                log.exception("Measurement cache unreadable for render %s; attempting exact-frame recovery", job.rk)
        admission = ADMISSION
        if not admission.acquire(blocking=False):
            raise ViewError(
                "QUEUE_FULL", "Measurement inputs are not cached and the renderer is busy. Try again shortly."
            )
        try:
            # Rebuild in a separate job: failed migration must leave the displayed cached view ready and unchanged.
            restored = Job(qk=job.qk, req=job.req)
            POOL.submit(contextvars.copy_context().run, build, restored, job.rk, job.cache).result()
            job.epochs, job.shape = restored.epochs, restored.shape
        finally:
            admission.release()


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
    """Forced aperture photometry on every frame (PLAN 5.9): r = r_px, background annulus 4-7 px.

    The position is the clicked grid pixel. Propagating a mover's position per epoch needs Gaia (#8, #29).
    """
    ensure_frames(job)
    w, _ = stack.common_grid(job.req.ra, job.req.dec, job.req.fov_arcmin)
    world = SkyCoord.from_pixel(x, y, w)
    pts = [p for ep in job.epochs for f in ep if (p := photometry.measure(f, x, y, r_px, world)) is not None]
    return sorted(pts, key=lambda p: p["t_mjd"])


def comparison(job: Job, x: float, y: float, r_px: float = 2.0) -> dict | None:
    """Calibration floor for the light curve: scatter of 3-6 field stars (None if the field has too few)."""
    ensure_frames(job)
    w, _ = stack.common_grid(job.req.ra, job.req.dec, job.req.fov_arcmin)
    return photometry.comparison([f for ep in job.epochs for f in ep], (x, y), r_px, w)


# ---------------------------------------------------------------- Gaia overlay (#29)


def _render_file(job: Job, name: str) -> bytes:
    if job.status != "ready" or not job.rk or job.cache is None:
        raise ViewError("NOT_READY", "This view is still being built. Try again when it is ready.")
    return job.cache.read(job.rk, name)


def gaia_overlay(job: Job, x: float | None = None, y: float | None = None, epoch: int = 0) -> dict:
    """gaia.json of the view; with x and y, also the Gaia match label of the source there in one epoch."""
    m = json.loads(_render_file(job, "manifest.json"))
    name = (m.get("extras") or {}).get("gaia")
    if not name:
        raise ViewError("NO_GAIA", "No Gaia overlay for this view: the Gaia archive did not answer when it was built.")
    result = json.loads(_render_file(job, name))
    result["selection"] = None
    if x is not None and y is not None:
        n = m["grid"]["ny"], m["grid"]["nx"]
        if not 0 <= epoch < len(m["epochs"]):
            raise ViewError("BAD_EPOCH", f"Epoch {epoch} is not in this view (0 to {len(m['epochs']) - 1}).")
        stacks = [np.frombuffer(_render_file(job, e["image"]), "<f4").reshape(n) for e in m["epochs"]]
        result["selection"] = gaia_dr3.match_label(result, stacks, x, y, epoch)
    return result
