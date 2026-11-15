import { raDecToEcliptic } from "./orbits";
import { tokenRgb } from "./stretch";

// The last three bins remain dust; V < 5.5 carries the naked-eye sky.
const MAG_LEVELS = [
  { limit: 0, radius: 1.5, alpha: 0.96 },
  { limit: 1.5, radius: 1.25, alpha: 0.93 },
  { limit: 2.5, radius: 1.1, alpha: 0.9 },
  { limit: 3.5, radius: 0.98, alpha: 0.84 },
  { limit: 4.5, radius: 0.86, alpha: 0.76 },
  { limit: 5, radius: 0.78, alpha: 0.7 },
  { limit: 5.5, radius: 0.72, alpha: 0.64 },
  { limit: 6, radius: 0.53, alpha: 0.44 },
  { limit: 6.5, radius: 0.43, alpha: 0.32 },
  { limit: Infinity, radius: 0.36, alpha: 0.25 },
] as const;
const COLOR_BINS = 5;

interface BrightStarCatalogue {
  count: number;
  ra: number[];
  dec: number[];
  vmag: number[];
  bv: (number | null)[];
}

export interface Starfield {
  /** Ecliptic unit vectors, packed by magnitude and B-V bucket. */
  xyz: Float32Array;
  buckets: { start: number; end: number; radius: number; alpha: number; color: string }[];
  halos: Starfield["buckets"];
}

let catalogue: Promise<Starfield | null> | undefined;

/** One local BSC5 request shared by both painters; a missing asset leaves the sky empty. */
export function loadStarfield(): Promise<Starfield | null> {
  return catalogue ??= fetch("/sky/bsc5.json")
    .then(async (response) => {
      if (!response.ok) throw new Error("Star catalogue unavailable");
      const data = await response.json() as BrightStarCatalogue;
      if (data.count !== data.ra.length || [data.dec, data.vmag, data.bv].some((a) => a.length !== data.count)) {
        throw new Error("Invalid star catalogue columns");
      }
      const white = tokenRgb("--star");
      const blue = tokenRgb("--accent");
      const warm = tokenRgb("--sun");
      const groups: number[][] = Array.from({ length: MAG_LEVELS.length * COLOR_BINS }, () => []);
      for (let i = 0; i < data.count; i++) {
        if (![data.ra[i], data.dec[i], data.vmag[i]].every(Number.isFinite)) throw new Error("Invalid star coordinates");
        const mag = MAG_LEVELS.findIndex((level) => data.vmag[i] < level.limit);
        // B-V follows stellar temperature: blue-white, white, cream, pale orange.
        const bv = data.bv[i] ?? 0.45;
        const color = Math.min(COLOR_BINS - 1, Math.max(0, Math.floor((bv + 0.4) / 2.4 * COLOR_BINS)));
        groups[mag * COLOR_BINS + color].push(i);
      }
      const xyz = new Float32Array(data.count * 3);
      let cursor = 0;
      const buckets = groups.map((indices, bucket) => {
        const start = cursor;
        for (const i of indices) {
          xyz.set(raDecToEcliptic(data.ra[i], data.dec[i]), cursor * 3);
          cursor++;
        }
        const level = MAG_LEVELS[Math.floor(bucket / COLOR_BINS)];
        const tone = bucket % COLOR_BINS;
        const tint = tone < 1 ? blue : warm;
        const mix = tone < 1 ? 0.16 : Math.max(0, tone - 1) * 0.1;
        const rgb = white.map((c, channel) => Math.round(c + (tint[channel] - c) * mix));
        return { start, end: cursor, radius: level.radius, alpha: level.alpha, color: `rgb(${rgb.join(",")})` };
      });
      // Only the catalogue's brightest 22 stars get layered, low-opacity halos.
      const halos = buckets.slice(0, 2 * COLOR_BINS).filter((b) => b.end > b.start).flatMap((bucket) =>
        [[4, 0.012], [2.8, 0.025], [1.8, 0.05]].map(([scale, alpha]) =>
          ({ ...bucket, radius: bucket.radius * scale, alpha })),
      );
      return { xyz, buckets: buckets.filter((bucket) => bucket.end > bucket.start), halos };
    })
    .catch(() => null);
}

/** Shared bucket painter. Coordinates and radii are CSS pixels under the canvas DPR transform. */
export function drawStarfield(
  context: CanvasRenderingContext2D,
  field: Starfield,
  projected: Float32Array,
  stride: 3 | 4,
  width: number,
  height: number,
  fade = 1,
  moving = false,
) {
  for (let pass = moving ? 1 : 0; pass < 2; pass++) {
    const buckets = pass === 0 ? field.halos : field.buckets;
    for (const bucket of buckets) {
      const r = bucket.radius;
      const margin = moving ? 50 : r;
      context.beginPath();
      for (let i = bucket.start * stride; i < bucket.end * stride; i += stride) {
        const x = projected[i], y = projected[i + 1];
        if (!Number.isFinite(x) || (stride === 3 && projected[i + 2] <= 0.04)
          || x < -margin || x > width + margin || y < -margin || y > height + margin) continue;
        if (moving) {
          context.moveTo(projected[i + 2], projected[i + 3]);
          context.lineTo(x, y);
        } else {
          context.moveTo(x + r, y);
          context.arc(x, y, r, 0, Math.PI * 2);
        }
      }
      context.globalAlpha = fade * bucket.alpha;
      if (moving) {
        context.strokeStyle = bucket.color;
        context.lineWidth = r * 2;
        context.stroke();
      } else {
        context.fillStyle = bucket.color;
        context.fill();
      }
    }
  }
  context.globalAlpha = fade;
}
