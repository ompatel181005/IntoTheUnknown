import { BAND_OPTIONS, FOV_OPTIONS, type Band, type Catalog, type CatalogObject, type FovArcmin } from "../types";

const DEG_TO_RAD = Math.PI / 180;
const MAS_TO_DEG = 1 / 3_600_000;
const J2000_OBLIQUITY_RAD = 23.43928 * DEG_TO_RAD;

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const nonempty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
export const isWebUrl = (value: unknown): value is string => {
  if (!nonempty(value)) return false;
  try { return ["http:", "https:"].includes(new URL(value).protocol); } catch { return false; }
};

/** Validate the full shared schema before any coordinates reach the canvas or view loader. */
export function validateCatalog(value: unknown): Catalog {
  if (!record(value) || !nonempty(value.version) || !nonempty(value.generated_at)
    || !record(value.source) || !["local", "azure_blob"].includes(String(value.source.kind))
    || !nonempty(value.source.uri) || !Array.isArray(value.objects)) throw new Error("Invalid catalog");
  const ids = new Set<string>();
  for (const object of value.objects) {
    if (!record(object) || !nonempty(object.id) || ids.has(object.id)
      || !nonempty(object.name) || !nonempty(object.kind)
      || !finite(object.ra_deg) || object.ra_deg < 0 || object.ra_deg >= 360
      || !finite(object.dec_deg) || Math.abs(object.dec_deg) > 90 || !finite(object.ref_epoch)
      || !["parallax_mas", "parallax_err_mas", "distance_pc", "pmra_mas_yr", "pmdec_mas_yr"]
        .every((key) => object[key] === null || finite(object[key]))
      || !(object.preset_id === null || nonempty(object.preset_id))
      || !record(object.provenance) || !nonempty(object.provenance.catalog) || !nonempty(object.provenance.ref)) throw new Error("Invalid catalog point");
    ids.add(object.id);
    if (object.view !== undefined) {
      const view = object.view;
      if (!record(view) || !isWebUrl(view.manifest_url) || !nonempty(view.built_at)
        || (view.catalog_version !== undefined && !nonempty(view.catalog_version))
        || (view.passes !== undefined && (!finite(view.passes) || !Number.isInteger(view.passes) || view.passes < 0))
        || !record(view.query) || !finite(view.query.ra) || view.query.ra < 0 || view.query.ra >= 360
        || !finite(view.query.dec) || Math.abs(view.query.dec) > 90
        || !finite(view.query.fov_arcmin) || view.query.fov_arcmin <= 0
        || !nonempty(view.query.band) || !nonempty(view.query.mode)) throw new Error("Invalid catalog view");
    }
  }
  return value as unknown as Catalog;
}

export function pointPosition(object: CatalogObject, now = new Date()) {
  const start = Date.UTC(now.getUTCFullYear(), 0, 1);
  const end = Date.UTC(now.getUTCFullYear() + 1, 0, 1);
  const current = propagate(object, now.getUTCFullYear() + (now.getTime() - start) / (end - start));
  const query = object.view?.query;
  return {
    ra: query?.ra ?? current.ra_deg,
    dec: query?.dec ?? current.dec_deg,
    fov: query && FOV_OPTIONS.includes(query.fov_arcmin as FovArcmin) ? query.fov_arcmin as FovArcmin : 6 as const,
    band: query && BAND_OPTIONS.includes(query.band as Band) ? query.band as Band : "auto" as const,
  };
}

export type CatalogDirection = [number, number, number];

export interface EclipticCatalogPosition {
  direction: CatalogDirection;
  distancePc: number | null;
}

/** Prefer an explicit distance, then use the reciprocal-parallax estimate. */
export function distancePc(object: CatalogObject): number | null {
  if (object.distance_pc !== null) return object.distance_pc;
  if (object.parallax_mas !== null && object.parallax_mas > 0) return 1000 / object.parallax_mas;
  return null;
}

/** Linearly propagate ICRS coordinates, treating pmra as mu_alpha*cos(dec). */
export function propagate(object: CatalogObject, epochYear: number): CatalogObject {
  const elapsedYears = epochYear - object.ref_epoch;
  const decRadians = object.dec_deg * DEG_TO_RAD;
  const cosDec = Math.cos(decRadians);
  const raShift = Math.abs(cosDec) > 1e-12
    ? (object.pmra_mas_yr ?? 0) * elapsedYears * MAS_TO_DEG / cosDec
    : 0;
  const decShift = (object.pmdec_mas_yr ?? 0) * elapsedYears * MAS_TO_DEG;

  return {
    ...object,
    ra_deg: ((object.ra_deg + raShift) % 360 + 360) % 360,
    dec_deg: Math.max(-90, Math.min(90, object.dec_deg + decShift)),
    ref_epoch: epochYear,
  };
}

/** Unit sky direction and optional radial distance in heliocentric ecliptic J2000. */
export function toEcliptic(object: CatalogObject): EclipticCatalogPosition {
  const ra = object.ra_deg * DEG_TO_RAD;
  const dec = object.dec_deg * DEG_TO_RAD;
  const x = Math.cos(dec) * Math.cos(ra);
  const y = Math.cos(dec) * Math.sin(ra);
  const z = Math.sin(dec);
  const cosObliquity = Math.cos(J2000_OBLIQUITY_RAD);
  const sinObliquity = Math.sin(J2000_OBLIQUITY_RAD);

  return {
    direction: [x, y * cosObliquity + z * sinObliquity, -y * sinObliquity + z * cosObliquity],
    distancePc: distancePc(object),
  };
}
