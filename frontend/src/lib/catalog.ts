import type { CatalogObject } from "../types";

const DEG_TO_RAD = Math.PI / 180;
const MAS_TO_DEG = 1 / 3_600_000;
const J2000_OBLIQUITY_RAD = 23.43928 * DEG_TO_RAD;

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
