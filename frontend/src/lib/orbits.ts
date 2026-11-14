// Approximate planet positions for the home orrery. Keplerian elements and rates from JPL's
// "Keplerian Elements for Approximate Positions of the Major Planets" (Standish), table 1, valid 1800-2050.
// Accurate to well under a degree: fine for a picture, not for science.

import { galacticToEq, seeded } from "./sky";

const D2R = Math.PI / 180;

interface Elements {
  name: string;
  a: [number, number]; // au, au/century
  e: [number, number];
  i: [number, number]; // deg, deg/century
  L: [number, number]; // mean longitude
  w: [number, number]; // longitude of perihelion
  node: [number, number]; // longitude of ascending node
}

export const PLANETS: Elements[] = [
  { name: "Mercury", a: [0.38709927, 0.00000037], e: [0.20563593, 0.00001906], i: [7.00497902, -0.00594749], L: [252.2503235, 149472.67411175], w: [77.45779628, 0.16047689], node: [48.33076593, -0.12534081] },
  { name: "Venus", a: [0.72333566, 0.0000039], e: [0.00677672, -0.00004107], i: [3.39467605, -0.0007889], L: [181.9790995, 58517.81538729], w: [131.60246718, 0.00268329], node: [76.67984255, -0.27769418] },
  { name: "Earth", a: [1.00000261, 0.00000562], e: [0.01671123, -0.00004392], i: [-0.00001531, -0.01294668], L: [100.46457166, 35999.37244981], w: [102.93768193, 0.32327364], node: [0, 0] },
  { name: "Mars", a: [1.52371034, 0.00001847], e: [0.0933941, 0.00007882], i: [1.84969142, -0.00813131], L: [-4.55343205, 19140.30268499], w: [-23.94362959, 0.44441088], node: [49.55953891, -0.29257343] },
  { name: "Jupiter", a: [5.202887, -0.00011607], e: [0.04838624, -0.00013253], i: [1.30439695, -0.00183714], L: [34.39644051, 3034.74612775], w: [14.72847983, 0.21252668], node: [100.47390909, 0.20469106] },
  { name: "Saturn", a: [9.53667594, -0.0012506], e: [0.05386179, -0.00050991], i: [2.48599187, 0.00193609], L: [49.95424423, 1222.49362201], w: [92.59887831, -0.41897216], node: [113.66242448, -0.28867794] },
  { name: "Uranus", a: [19.18916464, -0.00196176], e: [0.04725744, -0.00004397], i: [0.77263783, -0.00242939], L: [313.23810451, 428.48202785], w: [170.9542763, 0.40805281], node: [74.01692503, 0.04240589] },
  { name: "Neptune", a: [30.06992276, 0.00026291], e: [0.00859048, 0.00005105], i: [1.77004347, 0.00035372], L: [-55.12002969, 218.45945325], w: [44.96476227, -0.32241464], node: [131.78422574, -0.00508664] },
];

export type Vec3 = [number, number, number];

export interface SkyStar {
  pos: Vec3;
  size: number;
  brightness: number;
  tone: 0 | 1 | 2;
}

/** Julian centuries since J2000.0 for a JS date. */
export function centuries(date: Date): number {
  return (date.getTime() / 86400000 + 2440587.5 - 2451545.0) / 36525;
}

function solveKepler(M: number, e: number): number {
  let E = M + e * Math.sin(M);
  for (let k = 0; k < 8; k++) E -= (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
  return E;
}

/** Heliocentric ecliptic J2000 position (au) at mean anomaly offset `dM` radians from the date's (for orbit paths). */
export function position(p: Elements, T: number, dM = 0): Vec3 {
  const at = (x: [number, number]) => x[0] + x[1] * T;
  const a = at(p.a);
  const e = at(p.e);
  const i = at(p.i) * D2R;
  const L = at(p.L);
  const w = at(p.w);
  const node = at(p.node) * D2R;
  const argp = (w - at(p.node)) * D2R;
  const M = (((L - w) % 360) + 360) % 360 * D2R + dM;
  const E = solveKepler(M, e);
  const xp = a * (Math.cos(E) - e);
  const yp = a * Math.sqrt(1 - e * e) * Math.sin(E);
  const cw = Math.cos(argp), sw = Math.sin(argp), cn = Math.cos(node), sn = Math.sin(node), ci = Math.cos(i), si = Math.sin(i);
  return [
    (cw * cn - sw * sn * ci) * xp + (-sw * cn - cw * sn * ci) * yp,
    (cw * sn + sw * cn * ci) * xp + (-sw * sn + cw * cn * ci) * yp,
    sw * si * xp + cw * si * yp,
  ];
}

/** Unit vector for RA/Dec (equatorial), rotated into the ecliptic frame. */
export function raDecToEcliptic(raDeg: number, decDeg: number): Vec3 {
  const ra = raDeg * D2R;
  const dec = decDeg * D2R;
  const x = Math.cos(dec) * Math.cos(ra);
  const y = Math.cos(dec) * Math.sin(ra);
  const z = Math.sin(dec);
  const eps = 23.4393 * D2R;
  return [x, y * Math.cos(eps) + z * Math.sin(eps), -y * Math.sin(eps) + z * Math.cos(eps)];
}

/** A deterministic sky with most stars concentrated around the galactic plane. */
export function skyStars(count: number, radius: number): SkyStar[] {
  const random = seeded(0x53504858);
  const normal = () => {
    const u = Math.max(Number.EPSILON, random());
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random());
  };

  return Array.from({ length: count }, () => {
    const lon = random() * 360;
    const nearPlane = random() < 0.78;
    const lat = nearPlane
      ? Math.max(-55, Math.min(55, normal() * 11))
      : Math.asin(random() * 2 - 1) / D2R;
    const eq = galacticToEq(lon, lat);
    const unit = raDecToEcliptic(eq.ra, eq.dec);
    const brightness = random() ** 3.4;
    const tint = random();
    return {
      pos: [unit[0] * radius, unit[1] * radius, unit[2] * radius],
      size: 0.4 + brightness * 1.4,
      brightness,
      tone: tint < 0.025 ? 1 : tint < 0.07 ? 2 : 0,
    };
  });
}
