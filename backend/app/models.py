"""API contract (docs/PLAN.md 4.3). Mirrored by frontend/src/types.ts; change both together."""

from typing import Literal

from pydantic import BaseModel, Field

Fov = Literal[2, 4, 6, 10, 15]
Band = Literal["auto", "B1", "B2", "B3", "B4", "B5", "B6", "B1-B2", "B1-B3", "all"]
Stage = Literal["queued", "query", "fetch", "stack", "render", "ready", "error"]
# auto: saved cutouts when we have them, else live IRSA. saved: bundled demo pack only. live: always IRSA.
Source = Literal["auto", "saved", "live"]


class Health(BaseModel):
    ok: bool
    version: str
    irsa: Literal["up", "degraded", "down"]
    catalog_version: str


class Target(BaseModel):
    id: str
    name: str
    kind: Literal["motion", "variability"]
    ra: float
    dec: float
    ref_epoch: float | None = None
    pmra: float | None = None
    pmdec: float | None = None
    plx: float | None = None
    fov_arcmin: Fov
    band: Band


class ViewRequest(BaseModel):
    ra: float = Field(ge=0, lt=360)
    dec: float = Field(ge=-90, le=90)
    fov_arcmin: Fov = 6
    band: Band = "auto"
    mode: Literal["stack", "frames"] = "stack"
    source: Source = "auto"


class ApiError(BaseModel):
    code: str
    message: str


class ViewCreated(BaseModel):
    view_id: str
    status: Literal["ready", "queued"]
    manifest_url: str | None = None
    status_url: str | None = None


class Progress(BaseModel):
    done: int
    total: int


class ViewStatus(BaseModel):
    status: Stage
    progress: Progress | None = None
    manifest_url: str | None = None
    error: ApiError | None = None


class SpectrumPoint(BaseModel):
    lambda_um: float
    bw_um: float
    flux_mjysr: float | None
    err: float | None
    t_mjd: float
    detector: int
    flagged: bool


class Spectrum(BaseModel):
    points: list[SpectrumPoint]


class LightCurvePoint(BaseModel):
    t_mjd: float
    lambda_um: float
    flux_ujy: float
    err: float
    flagged: bool


class LightCurve(BaseModel):
    points: list[LightCurvePoint]
    comparison: dict | None = None


class GaiaStar(BaseModel):
    """One Gaia DR3 star: predicted grid pixel (x, y) per epoch, FITS orientation, 0-based (PLAN 5.8)."""

    source_id: int | None  # None for demo-pack catalogues, which carry no Gaia source_id
    g: float | None
    pmra: float | None
    pmdec: float | None
    plx: float | None
    track_px: list[tuple[float, float]]
    matched: list[bool]  # per epoch: a source was measured within 1.0 px of the track


class GaiaSelection(BaseModel):
    epoch: int
    centroid_px: tuple[float, float] | None
    label: Literal["match", "no_match", "unmeasured"]
    source_id: int | None
    sep_px: float | None


class GaiaResult(BaseModel):
    epochs_mjd: list[float]
    stars: list[GaiaStar]
    unexplained: list[dict] = []  # Tier 3 auto-flag; always empty for now
    selection: GaiaSelection | None = None  # with ?x=&y=&epoch=: the "Gaia match" label there
