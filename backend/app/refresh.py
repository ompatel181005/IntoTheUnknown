"""New-data refresh and status (docs/PLAN.md 4.4 and 4.5, issue #25).

The watcher in functions/ calls POST /internal/refresh when IRSA lists new SPHEREx data. The pinned views (the live
view of each of the five targets) are then re-queried, and re-rendered only where the archive has frames the cached
render lacks. A cached render keeps being served until the new one is complete and its pointer is swapped; old
`r/{rk}/` folders stay, so old links keep working.
"""

import concurrent.futures as cf
import hmac
import json
import logging
import threading
import time

from fastapi import APIRouter, Header
from fastapi.responses import JSONResponse

from . import config
from .models import ViewRequest
from .processing import views
from .targets import TARGETS

log = logging.getLogger(__name__)
router = APIRouter()

# One refresh render at a time, on its own thread, so a refresh never takes a slot from user renders.
_worker = cf.ThreadPoolExecutor(max_workers=1, thread_name_prefix="refresh")
_running = threading.Lock()  # held while a refresh run is queued, working or waiting to retry
# Waits before retrying the views that failed (IRSA outages usually clear within minutes).
# ponytail: retries live in this process; a restart or scale-to-zero during a wait drops them until the
# watcher's next catalog change. Answer the watcher with a failure instead if that ever matters.
RETRY_DELAYS_S = (300, 900)


def pinned_views() -> list[ViewRequest]:
    """The live view of each target. Their default (auto) view comes from the bundled cutouts and never changes."""
    return [ViewRequest(ra=t.ra, dec=t.dec, fov_arcmin=t.fov_arcmin, band=t.band, source="live") for t in TARGETS]


def frames_changed(manifest: dict, rows: list[dict]) -> bool:
    """True when the archive lists a frame newer than every frame of the render, or a collection it has not seen.

    ponytail: "newer than the newest used frame", not an exact set comparison, because a render drops thinned
    frames and underfilled passes. If the newest pass is always dropped this re-renders on every refresh (the
    render key is then unchanged, so nothing is re-uploaded). Store the queried frame ids in the pointer to fix.
    """
    used = {f["obs"] for f in manifest.get("frames") or []}
    collections = {f["collection"] for f in manifest.get("frames") or []}
    known = [r["t_mjd"] for r in rows if r["obs"] in used]
    if not known:
        return bool(rows)
    newest = max(known)
    return any(r["collection"] not in collections or (r["obs"] not in used and r["t_mjd"] > newest) for r in rows)


def refresh_view(req: ViewRequest) -> bool:
    """Re-render one view if the archive has new frames for it. True when the pointer moved to a new render."""
    qk = views.query_key(req)
    cache = views.get_cache()
    ptr = cache.lookup(qk)
    old_rk = ptr.get("render_key") if isinstance(ptr, dict) else None
    if old_rk:
        manifest = json.loads(cache.read(old_rk, "manifest.json"))
        if not frames_changed(manifest, views.live_rows(req, max_age_s=0, allow_stale=False)):
            return False
    job = views.Job(qk=qk, req=req)
    views.build(job)  # writes r/{rk}/ and swaps the pointer last; raises without touching the old render
    with views.LOCK:
        views.JOBS[qk] = job  # until this line every request was served the old render
    return job.rk != old_rk


def _refresh_pinned(reqs: list[ViewRequest]) -> None:
    try:
        for delay in (0, *RETRY_DELAYS_S):
            if delay:
                log.info("refresh: retrying %d failed views in %d s", len(reqs), delay)
                time.sleep(delay)
            failed = []
            for req in reqs:
                try:
                    moved = refresh_view(req)
                    log.info("refresh %.5f %+.5f: %s", req.ra, req.dec, "new render" if moved else "unchanged")
                except Exception as e:
                    log.warning("refresh %.5f %+.5f failed: %s", req.ra, req.dec, e)
                    failed.append(req)
            reqs = failed
            if not reqs:
                return
        log.error("refresh: gave up on %d views after %d retries", len(reqs), len(RETRY_DELAYS_S))
    finally:
        _running.release()


def _error(status: int, code: str, message: str) -> JSONResponse:
    return JSONResponse(status_code=status, content={"error": {"code": code, "message": message}})


@router.post("/internal/refresh", status_code=202)
def refresh(x_refresh_key: str | None = Header(None)):
    if not config.REFRESH_KEY:
        return _error(503, "REFRESH_DISABLED", "REFRESH_KEY is not configured on this server.")
    if not hmac.compare_digest((x_refresh_key or "").encode(), config.REFRESH_KEY.encode()):
        return _error(401, "BAD_REFRESH_KEY", "Missing or wrong X-Refresh-Key.")
    if not _running.acquire(blocking=False):
        return {"queued": 0, "running": True}  # ponytail: a change arriving mid-run waits for the next one
    reqs = pinned_views()
    try:
        _worker.submit(_refresh_pinned, reqs)
    except Exception:
        _running.release()
        raise
    return {"queued": len(reqs), "running": True}


@router.get("/api/status")
def status():
    """The watcher's catalog summary for a "data as of" badge; `catalog` is null until the watcher has run."""
    c = views.get_cache().catalog()
    keys = ("catalog_version", "collections", "latest_frame_mjd", "checked_at")
    return {"catalog": {k: c.get(k) for k in keys} if isinstance(c, dict) else None}
