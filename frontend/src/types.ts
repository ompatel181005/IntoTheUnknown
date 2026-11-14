// Mirror of the API contract in docs/PLAN.md section 4.3 (backend app/models.py).
// Change this file only together with the backend models.

export type FovArcmin = 2 | 4 | 6 | 10 | 15;
export const FOV_OPTIONS: readonly FovArcmin[] = [2, 4, 6, 10, 15];

export type Band = "auto" | "B1" | "B2" | "B3" | "B4" | "B5" | "B6" | "B1-B2" | "B1-B3" | "all";
export const BAND_OPTIONS: readonly Band[] = ["auto", "B1", "B2", "B3", "B4", "B5", "B6", "B1-B2", "B1-B3", "all"];

export interface Health {
  ok: boolean;
  version: string;
  irsa: "up" | "degraded" | "down";
  catalog_version: string;
}

export interface Target {
  id: string;
  name: string;
  kind: "motion" | "variability";
  ra: number;
  dec: number;
  ref_epoch?: number;
  pmra?: number;
  pmdec?: number;
  plx?: number;
  fov_arcmin: FovArcmin;
  band: Band;
}

/** auto: saved cutouts when available, else live IRSA. saved: bundled cutouts only. live: always IRSA. */
export type DataSource = "auto" | "saved" | "live";

export interface ViewRequest {
  ra: number;
  dec: number;
  fov_arcmin: FovArcmin;
  band: Band;
  mode: "stack" | "frames";
  source: DataSource;
}

export type ViewStage = "queued" | "query" | "fetch" | "stack" | "render" | "ready" | "error";

export interface ApiError {
  code: string;
  message: string;
}

export interface ViewCreated {
  view_id: string;
  status: "ready" | "queued";
  manifest_url?: string;
  status_url?: string;
}

export interface ViewStatus {
  status: ViewStage;
  progress?: { done: number; total: number };
  manifest_url?: string;
  error?: ApiError;
}

export interface Epoch {
  i: number;
  label: string;
  t_start: string;
  t_end: string;
  t_mean_mjd: number;
  n_frames: number;
  detectors: number[];
  lambda_um: [number, number];
  channels: number;
  flagged_px: Record<string, number>;
  astrom_resid_px: number | null;
  phot_scale: number;
  image: string;
  mask?: string | null;
  png?: string | null;
}

export interface Frame {
  obs: string;
  t_mjd: number;
  detector: number;
  lambda_um: number;
  epoch: number;
  collection: string;
}

export interface Manifest {
  schema: number;
  render_key: string;
  source: "irsa" | "s3" | "golden";
  pipeline_version: number;
  created_at: string;
  query: { ra: number; dec: number; fov_arcmin: FovArcmin; band: Band };
  grid: { nx: number; ny: number; pix_arcsec: number; wcs: Record<string, string | number> };
  catalog: { version: string; collections: string[] };
  /** Where these images came from. */
  origin?: { kind: "saved" | "live"; label: string; fetched: string | null; files: number; archive_exposures: number | null };
  stretch: { kind: "asinh"; vmin: number; vmax: number; beta: number };
  /** False when no channel is common to every epoch (stacks then use the channel union). */
  bandpass_matched?: boolean;
  epochs: Epoch[];
  frames: Frame[];
  extras: { gaia: string | null; lightcurve: string | null; cube: string | null };
}

export interface GaiaStar {
  source_id: number;
  g: number;
  pmra: number;
  pmdec: number;
  plx: number;
  track_px: [number, number][];
  matched: boolean[];
}

export interface GaiaResult {
  epochs_mjd: number[];
  stars: GaiaStar[];
  unexplained: { x: number; y: number; shift_px: number }[];
}

export interface SpectrumPoint {
  lambda_um: number;
  bw_um: number;
  flux_mjysr: number | null;
  err: number | null;
  t_mjd: number;
  detector: number;
  flagged: boolean;
}

export interface Spectrum {
  points: SpectrumPoint[];
}

export interface LightCurve {
  points: LightCurvePoint[];
  comparison: { n_stars: number; rms_frac: number } | null;
}

export interface LightCurvePoint {
  t_mjd: number;
  lambda_um: number;
  flux_ujy: number;
  err: number;
  flagged: boolean;
}
