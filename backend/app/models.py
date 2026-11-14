"""API contract (docs/PLAN.md 4.3). Mirrored by frontend/src/types.ts; change both together."""

from datetime import datetime
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


class CatalogSource(BaseModel):
    kind: Literal["local", "azure_blob"]
    uri: str


class CatalogProvenance(BaseModel):
    catalog: str
    ref: str


class CatalogObject(BaseModel):
    id: str
    name: str
    kind: str
    ra_deg: float = Field(ge=0, lt=360)
    dec_deg: float = Field(ge=-90, le=90)
    ref_epoch: float
    parallax_mas: float | None = Field(default=None, gt=0)
    parallax_err_mas: float | None = Field(default=None, ge=0)
    distance_pc: float | None = Field(default=None, gt=0)
    pmra_mas_yr: float | None = None
    pmdec_mas_yr: float | None = None
    preset_id: str | None = None
    provenance: CatalogProvenance


class Catalog(BaseModel):
    version: str
    generated_at: datetime
    source: CatalogSource
    objects: list[CatalogObject]


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
