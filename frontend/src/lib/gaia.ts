import type { GaiaResult } from "../types";

/** Arrow length multiplier: even Barnard's Star moves under 2 px between passes, too short to see at 1x. */
export const ARROW_GAIN = 5;
/** First-to-last motion below this is not drawn as an arrow. */
const MOVER_PX = 0.5;

export interface GaiaMark {
  /** Predicted position in this pass, SVG coordinates on the `0 0 nx ny` grid (y down). */
  x: number;
  y: number;
  /** SPHEREx measured a source on the prediction in this pass. */
  matched: boolean;
  /** First-to-last predicted motion, lengthened by ARROW_GAIN. */
  arrow: [number, number, number, number] | null;
}

/**
 * Gaia stars worth drawing in pass `index`. Stars SPHEREx never detects are skipped unless they move:
 * a 6 arcmin field can hold 600 catalogue stars, nearly all too faint to see.
 */
export function gaiaMarks(gaia: GaiaResult, index: number, ny: number): GaiaMark[] {
  // Grid pixels are 0-based with centres on integers, row 0 = south (same as SelectionMarker).
  const svg = ([px, py]: [number, number]): [number, number] => [px + 0.5, ny - py - 0.5];
  const marks: GaiaMark[] = [];
  for (const star of gaia.stars) {
    const here = star.track_px[index];
    if (!here) continue;
    const first = star.track_px[0];
    const last = star.track_px[star.track_px.length - 1];
    const moves = Math.hypot(last[0] - first[0], last[1] - first[1]) > MOVER_PX;
    if (!moves && !star.matched.some(Boolean)) continue;
    const [x, y] = svg(here);
    const [x1, y1] = svg(first);
    const [x2, y2] = svg(last);
    marks.push({
      x,
      y,
      matched: !!star.matched[index],
      arrow: moves ? [x1, y1, x1 + (x2 - x1) * ARROW_GAIN, y1 + (y2 - y1) * ARROW_GAIN] : null,
    });
  }
  return marks;
}
