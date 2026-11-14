import { formatDec, formatRa } from "../../lib/format";
import { gnomonic, niceStep } from "../../lib/sky";

export interface GridGeometry {
  lines: { d: string; kind: "ra" | "dec" }[];
  raLabels: { x: number; text: string }[];
  decLabels: { y: number; text: string }[];
}

interface Frame {
  /** Frame rect in the coordinate space the lines are drawn in. */
  left: number;
  top: number;
  side: number;
}

const ARCMIN_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600];

/**
 * True RA/Dec grid in the cutout's own TAN projection, centred on (ra0, dec0) and scaled so the
 * frame spans `fovDeg`. Lines cover a `w` x `h` area; labels sit where lines cross the frame edges.
 */
export function buildGrid(ra0: number, dec0: number, fovDeg: number, frame: Frame, w: number, h: number): GridGeometry {
  const scale = frame.side / fovDeg; // px per degree
  const cx = frame.left + frame.side / 2;
  const cy = frame.top + frame.side / 2;
  const spanDeg = Math.max(w, h) / scale;
  const decStepMin = ARCMIN_STEPS.find((s) => s >= (fovDeg * 60) / 4) ?? 600;
  const decStep = decStepMin / 60;
  const cosd = Math.max(0.05, Math.cos((dec0 * Math.PI) / 180));
  const raStep = niceStep(decStep / cosd, [1, 1.5, 2, 2.5, 5]);

  const project = (ra: number, dec: number): [number, number] | null => {
    const g = gnomonic(ra, dec, ra0, dec0);
    return g ? [cx - g[0] * scale, cy - g[1] * scale] : null;
  };
  const toPath = (pts: ([number, number] | null)[]) => {
    let d = "";
    let pen = false;
    for (const p of pts) {
      if (!p || Math.abs(p[0]) > 1e5 || Math.abs(p[1]) > 1e5) {
        pen = false;
        continue;
      }
      d += `${pen ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`;
      pen = true;
    }
    return d;
  };

  const lines: GridGeometry["lines"] = [];
  const raLabels: GridGeometry["raLabels"] = [];
  const decLabels: GridGeometry["decLabels"] = [];
  const decLo = Math.max(-89.9, dec0 - spanDeg);
  const decHi = Math.min(89.9, dec0 + spanDeg);
  const raHalf = Math.min(180, spanDeg / cosd);
  const n = 60;

  for (let dec = Math.ceil(decLo / decStep) * decStep; dec <= decHi; dec += decStep) {
    const pts = Array.from({ length: n + 1 }, (_, i) => project(ra0 - raHalf + (2 * raHalf * i) / n, dec));
    lines.push({ d: toPath(pts), kind: "dec" });
    const y = project(ra0, dec);
    if (y && y[1] > frame.top + 4 && y[1] < frame.top + frame.side - 4) decLabels.push({ y: y[1], text: formatDec(dec) });
  }
  for (let ra = Math.ceil((ra0 - raHalf) / raStep) * raStep; ra <= ra0 + raHalf; ra += raStep) {
    const pts = Array.from({ length: n + 1 }, (_, i) => project(ra, decLo + ((decHi - decLo) * i) / n));
    lines.push({ d: toPath(pts), kind: "ra" });
    const x = project(ra, dec0);
    if (x && x[0] > frame.left + 4 && x[0] < frame.left + frame.side - 4) raLabels.push({ x: x[0], text: formatRa(((ra % 360) + 360) % 360) });
  }
  return { lines, raLabels, decLabels };
}
