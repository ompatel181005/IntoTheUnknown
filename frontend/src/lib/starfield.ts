import { raDecToEcliptic } from "./orbits";
import { tokenRgb } from "./stretch";

const MAG_BINS = 12;
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
      const groups: number[][] = Array.from({ length: MAG_BINS * COLOR_BINS }, () => []);
      for (let i = 0; i < data.count; i++) {
        if (![data.ra[i], data.dec[i], data.vmag[i]].every(Number.isFinite)) throw new Error("Invalid star coordinates");
        const mag = Math.min(MAG_BINS - 1, Math.max(0, Math.floor((data.vmag[i] + 1.5) / 8 * MAG_BINS)));
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
        const magnitude = -1.5 + (Math.floor(bucket / COLOR_BINS) + 0.5) * 8 / MAG_BINS;
        // Compressed flux preserves bright-star contrast without losing the faint dust.
        const perceptual = 10 ** (-0.13 * (magnitude + 1.5));
        const tone = bucket % COLOR_BINS;
        const tint = tone < 1 ? blue : warm;
        const mix = tone < 1 ? 0.24 : Math.max(0, tone - 1) * 0.16;
        const rgb = white.map((c, channel) => Math.round(c + (tint[channel] - c) * mix));
        return { start, end: cursor, radius: 0.32 + 1.6 * perceptual, alpha: 0.18 + 0.8 * perceptual, color: `rgb(${rgb.join(",")})` };
      });
      return { xyz, buckets: buckets.filter((bucket) => bucket.end > bucket.start) };
    })
    .catch(() => null);
}
