import type { Manifest } from "../types";
import type { StretchKind } from "./url";

export type Rgb = [number, number, number];

export interface Palette {
  /** Diverging colormap ends for difference mode: negative (where it was), positive (where it is now). */
  neg: Rgb;
  pos: Rgb;
}

/** Read a token like --mover as an RGB triple, so canvas colors come from theme.css. */
export function tokenRgb(name: string): Rgb {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const hex = v.startsWith("#") ? v.slice(1) : "";
  if (hex.length === 6) {
    return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
  }
  return [255, 255, 255];
}

/** docs/PLAN.md 5.6: one locked (vmin, vmax, beta) for every epoch. */
export function stretchValue(x: number, s: Manifest["stretch"], kind: StretchKind, gain = 1): number {
  if (!Number.isFinite(x)) return 0;
  const span = (s.vmax - s.vmin) * gain;
  let y: number;
  if (kind === "linear") {
    y = (x - s.vmin) / span;
  } else {
    y = Math.asinh((x - s.vmin) / s.beta) / Math.asinh(span / s.beta);
  }
  return y < 0 ? 0 : y > 1 ? 1 : y;
}

/** Fill RGBA pixels for one epoch. FITS row 0 is south, so rows are flipped to put north up. */
export function renderEpoch(
  out: Uint8ClampedArray,
  img: Float32Array,
  nx: number,
  ny: number,
  s: Manifest["stretch"],
  kind: StretchKind,
  invert: boolean,
  gain = 1,
): void {
  for (let y = 0; y < ny; y++) {
    const src = (ny - 1 - y) * nx;
    for (let x = 0; x < nx; x++) {
      let v = stretchValue(img[src + x], s, kind, gain);
      if (invert) v = 1 - v;
      const g = Math.round(v * 255);
      const o = (y * nx + x) * 4;
      out[o] = g;
      out[o + 1] = g;
      out[o + 2] = g;
      out[o + 3] = 255;
    }
  }
}

/** Robust sigma of a difference image (MAD x 1.4826). */
function madSigma(d: Float32Array): number {
  const vals = Array.from(d).filter(Number.isFinite).sort((a, b) => a - b);
  if (!vals.length) return 1;
  const med = vals[Math.floor(vals.length / 2)];
  const dev = vals.map((v) => Math.abs(v - med)).sort((a, b) => a - b);
  return dev[Math.floor(dev.length / 2)] * 1.4826 || 1;
}

/** docs/PLAN.md 5.7: D = S_B - phot_scale * S_A, shown with a diverging map at +/- k sigma. */
export function renderDifference(
  out: Uint8ClampedArray,
  a: Float32Array,
  b: Float32Array,
  scaleA: number,
  nx: number,
  ny: number,
  palette: Palette,
  k = 4,
): void {
  const d = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) d[i] = b[i] - scaleA * a[i];
  const lim = k * madSigma(d);
  for (let y = 0; y < ny; y++) {
    const src = (ny - 1 - y) * nx;
    for (let x = 0; x < nx; x++) {
      const v = d[src + x];
      const t = Number.isFinite(v) ? Math.max(-1, Math.min(1, v / lim)) : 0;
      const c = t >= 0 ? palette.pos : palette.neg;
      const m = Math.abs(t);
      const o = (y * nx + x) * 4;
      out[o] = Math.round(c[0] * m);
      out[o + 1] = Math.round(c[1] * m);
      out[o + 2] = Math.round(c[2] * m);
      out[o + 3] = 255;
    }
  }
}
