// Sky geometry for the backdrop, the all-sky map and the RA/Dec grid. Pure math, no data.

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

export interface RaDec {
  ra: number;
  dec: number;
}

/** Wrap RA into [-180, 180) around 0, then flip so east is on the left (as on the sky). */
function lambda(raDeg: number): number {
  const l = ((raDeg + 180) % 360 + 360) % 360 - 180;
  return -l * D2R;
}

/**
 * Mollweide projection of the whole sky, RA 0h at the centre, east to the left.
 * Returns x in [-2, 2] and y in [-1, 1] (y up).
 */
export function mollweide(raDeg: number, decDeg: number): [number, number] {
  const phi = decDeg * D2R;
  let t = phi;
  if (Math.abs(Math.abs(phi) - Math.PI / 2) > 1e-9) {
    for (let i = 0; i < 12; i++) {
      const f = 2 * t + Math.sin(2 * t) - Math.PI * Math.sin(phi);
      t -= f / (2 + 2 * Math.cos(2 * t));
    }
  }
  const l = lambda(raDeg);
  return [((2 * Math.SQRT2) / Math.PI) * l * Math.cos(t) / Math.SQRT2, Math.sin(t)];
}

/** Ecliptic longitude (beta = 0) to equatorial, J2000 obliquity. */
export function eclipticToEq(lonDeg: number): RaDec {
  const eps = 23.43928 * D2R;
  const l = lonDeg * D2R;
  const dec = Math.asin(Math.sin(eps) * Math.sin(l));
  const ra = Math.atan2(Math.sin(l) * Math.cos(eps), Math.cos(l));
  return { ra: ((ra * R2D) % 360 + 360) % 360, dec: dec * R2D };
}

/** Galactic (l, b) to equatorial J2000. */
export function galacticToEq(lDeg: number, bDeg: number): RaDec {
  const raNgp = 192.85948 * D2R;
  const decNgp = 27.12825 * D2R;
  const lNcp = 122.93192 * D2R;
  const l = lDeg * D2R;
  const b = bDeg * D2R;
  const sinDec = Math.sin(b) * Math.sin(decNgp) + Math.cos(b) * Math.cos(decNgp) * Math.cos(lNcp - l);
  const dec = Math.asin(sinDec);
  const y = Math.cos(b) * Math.sin(lNcp - l);
  const x = Math.sin(b) * Math.cos(decNgp) - Math.cos(b) * Math.sin(decNgp) * Math.cos(lNcp - l);
  const ra = raNgp + Math.atan2(y, x);
  return { ra: ((ra * R2D) % 360 + 360) % 360, dec: dec * R2D };
}

/**
 * Split a sampled sky curve into Mollweide polylines, breaking where it crosses the map edge.
 * Points are in map units (x in [-2, 2], y in [-1, 1]).
 */
export function mollweidePolylines(points: RaDec[]): [number, number][][] {
  const out: [number, number][][] = [];
  let cur: [number, number][] = [];
  let prev: number | null = null;
  for (const p of points) {
    const xy = mollweide(p.ra, p.dec);
    if (prev !== null && Math.abs(xy[0] - prev) > 1.5) {
      if (cur.length > 1) out.push(cur);
      cur = [];
    }
    cur.push(xy);
    prev = xy[0];
  }
  if (cur.length > 1) out.push(cur);
  return out;
}

/**
 * Gnomonic (TAN) projection about (ra0, dec0), the same projection as the cutout grid.
 * Returns offsets in degrees on the tangent plane: x positive to the east (left on screen), y north.
 */
export function gnomonic(ra: number, dec: number, ra0: number, dec0: number): [number, number] | null {
  const a = (ra - ra0) * D2R;
  const d = dec * D2R;
  const d0 = dec0 * D2R;
  const cosc = Math.sin(d0) * Math.sin(d) + Math.cos(d0) * Math.cos(d) * Math.cos(a);
  if (cosc <= 0.05) return null;
  const x = (Math.cos(d) * Math.sin(a)) / cosc;
  const y = (Math.cos(d0) * Math.sin(d) - Math.sin(d0) * Math.cos(d) * Math.cos(a)) / cosc;
  return [x * R2D, y * R2D];
}

/** A "nice" grid step (1, 2, 5 x 10^n) close to `approx`. */
export function niceStep(approx: number, steps = [1, 2, 5]): number {
  const p = Math.pow(10, Math.floor(Math.log10(approx)));
  for (const s of steps) if (s * p >= approx) return s * p;
  return 10 * p;
}
