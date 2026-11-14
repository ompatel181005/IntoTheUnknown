import { useMemo } from "react";
import { formatDec, formatRa } from "../../lib/format";
import { eclipticToEq, galacticToEq, mollweide, mollweidePolylines, type RaDec } from "../../lib/sky";
import type { Preset } from "../../lib/targets";
import s from "./AllSkyMap.module.css";

interface AllSkyMapProps {
  targets: readonly Preset[];
  activeId: string | null;
  /** Extra marker for a custom position. */
  marker?: RaDec | null;
  onPick?: (p: Preset) => void;
  /** Small inset version: no labels, no buttons. */
  compact?: boolean;
}

const W = 4.2;
const H = 2.2;
const toPct = ([x, y]: [number, number]) => ({ left: `${((x + W / 2) / W) * 100}%`, top: `${((H / 2 - y) / H) * 100}%` });
const path = (pts: [number, number][]) => pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(4)},${(-y).toFixed(4)}`).join("");

function sample(fn: (t: number) => RaDec, from: number, to: number, n = 180): RaDec[] {
  return Array.from({ length: n + 1 }, (_, i) => fn(from + ((to - from) * i) / n));
}

/**
 * The whole sky in a Mollweide projection (RA 0h at centre, east left): RA/Dec grid, the ecliptic and
 * the galactic plane drawn where they really are, and the five targets at their real positions.
 */
export function AllSkyMap({ targets, activeId, marker, onPick, compact }: AllSkyMapProps) {
  const geo = useMemo(() => {
    const meridians = [-150, -120, -90, -60, -30, 0, 30, 60, 90, 120, 150].map((ra) =>
      path(mollweidePolylines(sample((d) => ({ ra, dec: d }), -89.9, 89.9, 90))[0] ?? []),
    );
    const parallels = [-60, -30, 0, 30, 60].flatMap((dec) =>
      mollweidePolylines(sample((r) => ({ ra: r, dec }), -179.99, 179.99, 180)).map(path),
    );
    const ecliptic = mollweidePolylines(sample(eclipticToEq, 0, 360, 360)).map(path);
    // Galactic band: brighter toward the galactic centre (l = 0).
    const band = Array.from({ length: 24 }, (_, i) => {
      const l0 = i * 15;
      const lines = mollweidePolylines(sample((l) => galacticToEq(l, 0), l0, l0 + 15.5, 16)).map(path);
      const near = Math.cos(((l0 + 7.5) * Math.PI) / 180);
      return { d: lines.join(""), strength: 0.35 + 0.65 * Math.max(0, near) ** 2 };
    });
    return { meridians, parallels, ecliptic, band };
  }, []);

  const raLabels = [0, 3, 6, 9, 12, 15, 18, 21].map((h) => ({ h, xy: mollweide(h * 15, 0) }));
  const decLabels = [-60, -30, 30, 60].map((d) => ({ d, xy: mollweide(179.99, d) }));

  return (
    <div className={s.map} data-compact={compact}>
      <svg viewBox={`${-W / 2} ${-H / 2} ${W} ${H}`} className={s.svg} aria-hidden="true">
        <defs>
          <filter id="band-blur" x="-20%" y="-50%" width="140%" height="200%">
            <feGaussianBlur stdDeviation="0.045" />
          </filter>
          <clipPath id="sky-clip">
            <ellipse cx="0" cy="0" rx="2" ry="1" />
          </clipPath>
        </defs>
        <ellipse cx="0" cy="0" rx="2" ry="1" className={s.disc} />
        <g clipPath="url(#sky-clip)">
          <g filter="url(#band-blur)">
            {geo.band.map((b, i) => (
              <path key={i} d={b.d} className={s.band} style={{ strokeOpacity: b.strength * 0.55, strokeWidth: 0.09 + b.strength * 0.08 }} />
            ))}
          </g>
          {geo.band.map((b, i) => (
            <path key={`c${i}`} d={b.d} className={s.bandCore} style={{ strokeOpacity: b.strength * 0.4 }} />
          ))}
          {geo.meridians.map((d, i) => (
            <path key={`m${i}`} d={d} className={s.grid} />
          ))}
          {geo.parallels.map((d, i) => (
            <path key={`p${i}`} d={d} className={s.grid} />
          ))}
          {geo.ecliptic.map((d, i) => (
            <path key={`e${i}`} d={d} className={s.ecliptic} />
          ))}
        </g>
        <ellipse cx="0" cy="0" rx="2" ry="1" className={s.rim} />
      </svg>

      {!compact && (
        <>
          {raLabels.map(({ h, xy }) => (
            <span key={h} className={`${s.axis} mono`} style={toPct([xy[0], xy[1] - 0.04])}>
              {h}h
            </span>
          ))}
          {decLabels.map(({ d, xy }) => (
            <span key={d} className={`${s.axis} ${s.axisDec} mono`} style={toPct(xy)}>
              {d > 0 ? `+${d}` : d}°
            </span>
          ))}
          <span className={`${s.legend} micro`}>
            <span className={s.legendEcl} /> Ecliptic <span className={s.legendBand} /> Milky Way
          </span>
        </>
      )}

      {targets.map((t) => {
        const xy = mollweide(t.ra, t.dec);
        const pos = toPct(xy);
        const active = t.id === activeId;
        if (compact) {
          return active ? <span key={t.id} className={s.dotActive} style={pos} /> : <span key={t.id} className={s.dot} style={pos} />;
        }
        return (
          <button
            key={t.id}
            type="button"
            className={s.target}
            style={pos}
            data-active={active}
            data-side={xy[0] > 0.9 ? "left" : "right"}
            onClick={() => onPick?.(t)}
            aria-label={`${t.name}, RA ${formatRa(t.ra)}, Dec ${formatDec(t.dec)}`}
          >
            <span className={s.ring} aria-hidden="true" />
            <span className={s.label}>
              <span className={s.name}>{t.name}</span>
              <span className="micro">{t.kind === "motion" ? "Moves" : "Changes brightness"}</span>
            </span>
          </button>
        );
      })}
      {marker && <span className={s.dotActive} style={toPct(mollweide(marker.ra, marker.dec))} />}
    </div>
  );
}
