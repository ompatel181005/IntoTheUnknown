"""FastAPI app: routes from docs/PLAN.md 4.3."""

import logging
import time
import urllib.request

from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from . import config, refresh
from .models import GaiaResult, Health, LightCurve, Spectrum, Target, ViewCreated, ViewRequest, ViewStatus
from .processing import views
from .targets import TARGETS
from .telemetry import FASTAPI_TELEMETRY, configure_telemetry

logging.basicConfig(level=logging.INFO)
app = FastAPI(title="SPHEREx Blink API", version="0.1.0", telemetry=FASTAPI_TELEMETRY)
configure_telemetry(app)
app.add_middleware(CORSMiddleware, allow_origins=config.CORS_ORIGINS, allow_methods=["*"], allow_headers=["*"])
config.CACHE_DIR.mkdir(parents=True, exist_ok=True)
app.mount("/frames", StaticFiles(directory=config.CACHE_DIR), name="frames")

_irsa = {"t": 0.0, "state": "up"}


def irsa_state() -> str:
    """Cheap probe of IRSA's SIA endpoint, cached for a minute."""
    if time.time() - _irsa["t"] > 60:
        try:
            with urllib.request.urlopen(
                "https://irsa.ipac.caltech.edu/SIA?COLLECTION=spherex_dr1&MAXREC=0", timeout=5
            ) as r:
                _irsa["state"] = "up" if r.status == 200 else "degraded"
        except Exception:
            _irsa["state"] = "down"
        _irsa["t"] = time.time()
    return _irsa["state"]


@app.exception_handler(views.ViewError)
def view_error(_, e: views.ViewError):
    """Every route failure uses the {"error": {code, message}} body the frontend reads."""
    status = 429 if e.code == "QUEUE_FULL" else 404 if e.code == "UNKNOWN_VIEW" else 503
    headers = {"Retry-After": "2"} if e.code == "QUEUE_FULL" else None
    return JSONResponse(status_code=status, headers=headers, content={"error": {"code": e.code, "message": e.message}})


@app.get("/api/health", response_model=Health)
def health():
    return Health(ok=True, version=app.version, irsa=irsa_state(), catalog_version="spherex_dr1+spherex_qr3")


@app.get("/api/targets", response_model=list[Target])
def targets():
    return TARGETS


@app.post("/api/views", response_model=ViewCreated, status_code=202)
def create_view(req: ViewRequest):
    job = views.create(req)
    if job.status == "ready":
        return JSONResponse(
            status_code=200,
            content=ViewCreated(view_id=job.qk, status="ready", manifest_url=job.manifest_url).model_dump(),
        )
    return ViewCreated(view_id=job.qk, status="queued", status_url=f"/api/views/{job.qk}")


def _job(view_id: str, render_key: str | None = None) -> views.Job:
    job = views.JOBS.get(view_id)
    if not job:
        raise views.ViewError("UNKNOWN_VIEW", "This view is not known to the server. Load it again.")
    if render_key is not None and job.rk != render_key:
        raise views.ViewError(
            "RENDER_CHANGED", "A newer render is available for this field. Reopen it before taking measurements."
        )
    return job


@app.get("/api/views/{view_id}", response_model=ViewStatus)
def view_status(view_id: str):
    job = _job(view_id)
    out = {"status": job.status, "manifest_url": job.manifest_url}
    if job.total:
        out["progress"] = {"done": job.done, "total": job.total}
    if job.error:
        out["error"] = {"code": job.error[0], "message": job.error[1]}
    return out


@app.get("/api/views/{view_id}/spectrum", response_model=Spectrum)
def view_spectrum(
    view_id: str,
    x: int = Query(..., ge=0),
    y: int = Query(..., ge=0),
    epoch: int = 0,
    render_key: str | None = Query(None, pattern="^[0-9a-f]{24}$"),
):
    return {"points": views.spectrum(_job(view_id, render_key), x, y, epoch)}


@app.get("/api/views/{view_id}/lightcurve", response_model=LightCurve)
def view_lightcurve(
    view_id: str,
    x: float = Query(..., ge=0),
    y: float = Query(..., ge=0),
    r_px: float = Query(2.0, gt=0, lt=4),  # the background annulus starts at 4 px
    render_key: str | None = Query(None, pattern="^[0-9a-f]{24}$"),
):
    job = _job(view_id, render_key)
    return {"points": views.lightcurve(job, x, y, r_px), "comparison": views.comparison(job, x, y, r_px)}


@app.get("/api/views/{view_id}/gaia", response_model=GaiaResult)
def view_gaia(
    view_id: str,
    x: float | None = Query(None, ge=0),
    y: float | None = Query(None, ge=0),
    epoch: int = Query(0, ge=0),
    render_key: str | None = Query(None, pattern="^[0-9a-f]{24}$"),
):
    """Gaia overlay (#29): per-star pixel tracks and matches; with x and y, the match label of that source."""
    return views.gaia_overlay(_job(view_id, render_key), x, y, epoch)


app.include_router(refresh.router)

# Production: the built React app (frontend/dist) is served from the same origin. Mounted last so /api and /frames win.
_DIST = config.ROOT / "frontend" / "dist"
if _DIST.is_dir():
    app.mount("/", StaticFiles(directory=_DIST, html=True), name="web")
