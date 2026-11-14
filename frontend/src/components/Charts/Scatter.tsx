import { useId } from "react";
import s from "./Scatter.module.css";

export interface ScatterPoint {
  x: number;
  y: number;
  /** Half-width of a horizontal error bar, in x units. */
  xerr?: number;
  yerr?: number | null;
  hollow?: boolean;
  /** Highlight (current epoch). */
  active?: boolean;
  title?: string;
}

interface ScatterProps {
  points: ScatterPoint[];
  xLabel: string;
  yLabel: string;
  formatX?: (v: number) => string;
  formatY?: (v: number) => string;
  /** Accessible summary of what the chart shows. */
  summary: string;
}

const W = 300;
const H = 180;
const PAD = { l: 52, r: 10, t: 10, b: 30 };

function ticks(lo: number, hi: number, n = 4) {
  if (hi <= lo) return [lo];
  const raw = (hi - lo) / n;
  const p = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * p).find((v) => v >= raw) ?? raw;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(+v.toPrecision(12));
  return out;
}

/** Small SVG scatter with error bars. Hollow points mark flagged data. */
export function Scatter({ points, xLabel, yLabel, formatX = String, formatY = String, summary }: ScatterProps) {
  const id = useId();
  const xs = points.flatMap((p) => [p.x - (p.xerr ?? 0), p.x + (p.xerr ?? 0)]);
  const ys = points.flatMap((p) => [p.y - (p.yerr ?? 0), p.y + (p.yerr ?? 0)]);
  let [x0, x1] = [Math.min(...xs), Math.max(...xs)];
  let [y0, y1] = [Math.min(...ys), Math.max(...ys)];
  if (x0 === x1) [x0, x1] = [x0 - 1, x1 + 1];
  if (y0 === y1) [y0, y1] = [y0 - 1, y1 + 1];
  const padY = (y1 - y0) * 0.08;
  y0 -= padY;
  y1 += padY;
  const sx = (v: number) => PAD.l + ((v - x0) / (x1 - x0)) * (W - PAD.l - PAD.r);
  const sy = (v: number) => H - PAD.b - ((v - y0) / (y1 - y0)) * (H - PAD.t - PAD.b);

  return (
    <figure className={s.figure}>
      <svg viewBox={`0 0 ${W} ${H}`} className={s.svg} role="img" aria-labelledby={`${id}-d`}>
        <desc id={`${id}-d`}>{summary}</desc>
        {ticks(y0, y1).map((t) => (
          <g key={`y${t}`}>
            <line x1={PAD.l} x2={W - PAD.r} y1={sy(t)} y2={sy(t)} className={s.gridline} />
            <text x={PAD.l - 6} y={sy(t)} className={s.tick} textAnchor="end" dominantBaseline="middle">
              {formatY(t)}
            </text>
          </g>
        ))}
        {ticks(x0, x1).map((t) => (
          <text key={`x${t}`} x={sx(t)} y={H - PAD.b + 14} className={s.tick} textAnchor="middle">
            {formatX(t)}
          </text>
        ))}
        <line x1={PAD.l} x2={W - PAD.r} y1={H - PAD.b} y2={H - PAD.b} className={s.axis} />
        {points.map((p, i) => (
          <g key={i} className={p.active ? s.active : undefined}>
            {p.xerr ? <line x1={sx(p.x - p.xerr)} x2={sx(p.x + p.xerr)} y1={sy(p.y)} y2={sy(p.y)} className={s.err} /> : null}
            {p.yerr ? <line x1={sx(p.x)} x2={sx(p.x)} y1={sy(p.y - p.yerr)} y2={sy(p.y + p.yerr)} className={s.err} /> : null}
            <circle cx={sx(p.x)} cy={sy(p.y)} r={p.active ? 4 : 3} className={p.hollow ? s.hollow : s.dot}>
              {p.title && <title>{p.title}</title>}
            </circle>
          </g>
        ))}
      </svg>
      <figcaption className={s.caption}>
        <span className={s.axisLabel}>{yLabel}</span>
        <span className={s.axisLabel}>{xLabel}</span>
      </figcaption>
    </figure>
  );
}
