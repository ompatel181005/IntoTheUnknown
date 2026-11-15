import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { LoadedView } from "../../data/source";
import { useCatalog } from "../../hooks/useCatalog";
import type { ViewState as LoadState } from "../../hooks/useView";
import { markFlight, registerDomeFlight, setFlightFocus } from "../../lib/flight";
import { formatDec, formatRa } from "../../lib/format";
import { renderDifference, renderEpoch, tokenRgb } from "../../lib/stretch";
import { PRESETS, type Preset } from "../../lib/targets";
import type { Overlays, StretchKind, ViewMode } from "../../lib/url";
import type { CatalogObject, FovArcmin } from "../../types";
import { Orrery } from "../Orrery/Orrery";
import { GlassButton, GlassPanel, Icon } from "../glass";
import { buildGrid } from "./grid";
import s from "./SkyStage.module.css";

interface SkyStageProps {
  load: LoadState;
  target: Preset | null;
  ra: number | null;
  dec: number | null;
  fov: FovArcmin;
  index: number;
  mode: ViewMode;
  stretch: StretchKind;
  invert: boolean;
  smooth: boolean;
  gain: number;
  /** Reference pass for Difference. */
  refIndex: number;
  overlays: Pick<Overlays, "flags" | "grid">;
  flying: boolean;
  onFullscreen: () => void;
  /** Show the leader-line label beside the dome (hidden when a panel covers it). */
  showLabel: boolean;
  /** Selected grid pixel, FITS orientation (row 0 = south). */
  sel: [number, number] | null;
  onSelect: (xy: [number, number] | null) => void;
  onRetry: () => void;
  onPreset: (p: Preset) => void;
  /** Opening a target from the home orrery; `from` is where the flight ended on screen. */
  onOpenFromHome: (p: Preset, from: { x: number; y: number } | null) => void;
  flightOrigin: { x: number; y: number } | null;
  onFlightStart: (p: Preset) => void;
  onFlightEnd: () => void;
  /** Move the measuring cursor without opening the drawer (keyboard). */
  onCursor: (xy: [number, number]) => void;
  onTour: () => void;
}

const NO_TARGETS: readonly CatalogObject[] = [];

export function SkyStage(props: SkyStageProps) {
  const { load } = props;
  // Keep the catalog alive across the dome so a return does not rebuild an empty home first.
  const catalog = useCatalog();
  useEffect(() => {
    if (load.kind === "ready") markFlight("data-ready");
  }, [load.kind]);
  if (load.kind === "idle") return <Home targets={catalog.catalog?.objects ?? NO_TARGETS} onPick={props.onOpenFromHome} onFlightStart={props.onFlightStart} onFlightEnd={props.onFlightEnd} onTour={props.onTour} flying={props.flying} onFullscreen={props.onFullscreen} />;
  const empty = load.kind === "ready" && load.view.manifest.epochs.length === 0;
  return (
    <section className={s.stage} aria-label="Sky view">
      {load.kind === "error" && <ErrorCard message={load.message} onRetry={props.onRetry} />}
      {empty && <NoCoverage onRetry={props.onRetry} />}
      {(load.kind === "loading" || (load.kind === "ready" && !empty)) && (
        // Keyed by position so the telescope zoom plays once per target, not again when data arrives.
        <Eyepiece key={`${props.ra},${props.dec}`} {...props} view={load.kind === "ready" ? load.view : null}>
          {load.kind === "loading" && <Loading load={load} />}
        </Eyepiece>
      )}
    </section>
  );
}

/** First visit: a live holographic orrery, with the five targets on the sky around the solar system. */
function Home({
  targets,
  onPick,
  onFlightStart,
  onFlightEnd,
  flying,
  onFullscreen,
}: {
  targets: readonly CatalogObject[];
  onPick: (p: Preset, from: { x: number; y: number } | null) => void;
  onFlightStart: (p: Preset) => void;
  onFlightEnd: () => void;
  onTour: () => void;
  flying: boolean;
  onFullscreen: () => void;
}) {
  useEffect(() => {
    if (!flying) return;
    const onKey = (event: KeyboardEvent) => {
      const editing = event.target instanceof Element && event.target.closest('input, select, textarea, dialog, [contenteditable="true"]');
      if (editing || event.metaKey || event.ctrlKey || event.altKey) return;
      if (!["+", "=", "-", "_", "0"].includes(event.key)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    // Keep zoom shortcuts inactive through the panel fade after the camera lands.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [flying]);

  return (
    <section className={s.home} aria-labelledby="home-title">
      <div className={s.homeText}>
        <h2 id="home-title" className={`display ${s.homeTitle}`}>
          Pick a target
        </h2>
      </div>
      <div className={s.homeMap} data-tour="orrery">
        <Orrery
          targets={targets}
          onPick={(object, from) => {
            const preset = PRESETS.find((candidate) => candidate.id === object.preset_id);
            if (preset) onPick(preset, from);
          }}
          onFlightStart={(object) => {
            const preset = PRESETS.find((candidate) => candidate.id === object.preset_id);
            if (preset) onFlightStart(preset);
          }}
          onFlightEnd={onFlightEnd}
        />
      </div>
      <div className={s.zoomControls} aria-label="Orrery zoom controls" data-flight-hide inert={flying}>
        <button
          type="button"
          className={s.zoomButton}
          aria-label="Zoom in"
          onClick={() => window.dispatchEvent(new CustomEvent("spherex:orrery-zoom", { detail: 1 }))}
        >
          +
        </button>
        <button
          type="button"
          className={s.zoomButton}
          aria-label="Zoom out"
          onClick={() => window.dispatchEvent(new CustomEvent("spherex:orrery-zoom", { detail: -1 }))}
        >
          −
        </button>
        <button type="button" className={s.zoomButton} aria-label="Full screen" onClick={onFullscreen}>
          <Icon name="fullscreen" size={18} />
        </button>
      </div>
    </section>
  );
}

function useBox<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [box, setBox] = useState<{ left: number; top: number; side: number; vw: number; vh: number } | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      // Mid-zoom the frame is scaled and offset; measuring then would place the grid wrongly.
      if (el.closest("[data-zooming]")) return;
      const r = el.getBoundingClientRect();
      const next = { left: Math.round(r.left), top: Math.round(r.top), side: Math.round(r.width), vw: window.innerWidth, vh: window.innerHeight };
      setBox((prev) =>
        prev && prev.left === next.left && prev.top === next.top && prev.side === next.side && prev.vw === next.vw && prev.vh === next.vh
          ? prev
          : next,
      );
    };
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    const stage = el.closest("section");
    if (stage) ro.observe(stage);
    const onTransitionEnd = (event: TransitionEvent) => {
      if (event.propertyName.startsWith("padding")) measure();
    };
    window.addEventListener("resize", measure);
    window.addEventListener("spherex:dome-landed", measure);
    document.addEventListener("transitionend", onTransitionEnd);
    const raf = requestAnimationFrame(measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
      window.removeEventListener("spherex:dome-landed", measure);
      document.removeEventListener("transitionend", onTransitionEnd);
      cancelAnimationFrame(raf);
    };
  }, []);
  return [ref, box] as const;
}

/** The dome: circular frame, position-angle ring, RA/Dec grid across the sky, and the target label. */
function Eyepiece(props: SkyStageProps & { view: LoadedView | null; children?: ReactNode }) {
  const { view, ra, dec, index, mode } = props;
  const [frameRef, box] = useBox<HTMLDivElement>();
  const columnRef = useRef<HTMLDivElement>(null);
  const onFlightEndRef = useRef(props.onFlightEnd);
  useEffect(() => {
    onFlightEndRef.current = props.onFlightEnd;
  }, [props.onFlightEnd]);
  // Captured once at mount: the dome grows out of the spot the flight ended (or the centre).
  const [origin] = useState(() => {
    markFlight("eyepiece-render");
    return props.flightOrigin;
  });

  // Telescope zoom on the real DOM (stays crisp, unlike a scaled snapshot), one easing for the whole move.
  useLayoutEffect(() => {
    markFlight("eyepiece-layout");
    const col = columnRef.current;
    if (!col) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const r = col.getBoundingClientRect();
    setFlightFocus(r.left + r.width / 2, r.top + r.height / 2);
    const dx = origin ? origin.x - (r.left + r.width / 2) : 0;
    const dy = origin ? origin.y - (r.top + r.height / 2) : 0;
    col.dataset.zooming = "1";
    let cancelled = false;
    const land = () => {
      if (cancelled) return;
      markFlight("dome-land");
      delete col.dataset.zooming;
      window.dispatchEvent(new Event("spherex:dome-landed"));
      const defer = window.requestIdleCallback ?? ((callback: IdleRequestCallback) => window.setTimeout(callback, 50));
      defer(() => onFlightEndRef.current?.(), { timeout: 200 });
    };
    const unregister = registerDomeFlight({
      centre: () => {
        const box = col.getBoundingClientRect();
        return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
      },
      shrink: async () => {
        if (typeof col.animate !== "function") return;
        const box = col.getBoundingClientRect();
        const x = window.innerWidth / 2 - (box.left + box.width / 2);
        const y = window.innerHeight / 2 - (box.top + box.height / 2);
        col.dataset.zooming = "1";
        const animation = col.animate(
          [
            { transform: "translate(0, 0) scale(1)", opacity: 1 },
            { transform: `translate(${x}px, ${y}px) scale(0.06)`, opacity: 0 },
          ],
          { duration: reduce ? 150 : 300, easing: "cubic-bezier(0.65, 0, 0.35, 1)", fill: "forwards" },
        );
        await animation.finished.catch(() => undefined);
        delete col.dataset.zooming;
      },
    });
    if (typeof col.animate !== "function") {
      land();
      return unregister;
    }
    const zoom = reduce
      ? col.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 150, easing: "linear" })
      : col.animate(
          [
            { transform: `translate(${dx}px, ${dy}px) scale(0.06)`, opacity: 0 },
            { opacity: 1, offset: 0.3 },
            { transform: "translate(0, 0) scale(1)", opacity: 1 },
          ],
          { duration: 750, easing: "cubic-bezier(0.65, 0, 0.35, 1)" },
        );
    zoom.finished.then(land, land);
    return () => {
      cancelled = true;
      zoom.cancel();
      delete col.dataset.zooming;
      unregister();
    };
  }, [origin]);
  const m = view?.manifest;
  const fovDeg = m ? (m.grid.nx * m.grid.pix_arcsec) / 3600 : props.fov / 60;
  const fovArcmin = fovDeg * 60;
  const diff = mode === "diff" && (m?.epochs.length ?? 0) > 1;

  const outer = useMemo(
    () => (box && ra !== null && dec !== null ? buildGrid(ra, dec, fovDeg, box, box.vw, box.vh) : null),
    [box, ra, dec, fovDeg],
  );
  const inner = useMemo(
    () =>
      box && ra !== null && dec !== null && props.overlays.grid
        ? buildGrid(ra, dec, fovDeg, { left: 0, top: 0, side: box.side }, box.side, box.side)
        : null,
    [box, ra, dec, fovDeg, props.overlays.grid],
  );

  // Room between the frame and the tool rail on the right (rail 52px + gutters).
  const labelRoom = box ? box.vw - (box.left + box.side / 2 + (box.side / 2 + 36) * 0.7071 + 60) - 84 : 0;
  const showLabel = props.showLabel && labelRoom > 160 && box !== null;

  return (
    <>
      {box && outer && (
        <svg
          className={`${s.sky} ${s.skyIn}`}
          width={box.vw}
          height={box.vh}
          aria-hidden="true"
        >
          <defs>
            <mask id="frame-hole">
              <rect width={box.vw} height={box.vh} fill="white" />
              <circle cx={box.left + box.side / 2} cy={box.top + box.side / 2} r={box.side / 2 + 1} fill="black" />
            </mask>
          </defs>
          <g mask="url(#frame-hole)">
            {outer.lines.map((l, i) => (
              <path key={i} d={l.d} className={s.gridLine} />
            ))}
          </g>
          {outer.decLabels.map((l) => (
            <text key={l.text} x={box.left - 46} y={l.y} className={`${s.gridLabel} mono`} textAnchor="end" dominantBaseline="middle">
              {l.text}
            </text>
          ))}
          {outer.raLabels.map((l) => (
            <text key={l.text} x={l.x} y={box.top + box.side + 54} className={`${s.gridLabel} mono`} textAnchor="middle">
              {l.text}
            </text>
          ))}
          <DomeRing left={box.left} top={box.top} side={box.side} />
          {showLabel && <Leader left={box.left} top={box.top} side={box.side} />}
        </svg>
      )}

      <div ref={columnRef} className={s.column}>
        <div className={`${s.topRow} mono`}>
          <ScaleBar side={box?.side ?? 0} fovArcmin={fovArcmin} />
          {diff ? (
            <span className={s.legend} aria-label="Difference: silver was, amber is now">
              <span>
                <span className={s.swatchNeg} />
                Was −
              </span>
              <span>
                <span className={s.swatchPos} />
                Now +
              </span>
            </span>
          ) : m && m.epochs.length === 1 ? (
            <span>One pass; nothing to compare</span>
          ) : (
            <span className={s.hintText}>Click to measure</span>
          )}
        </div>
        <div
          ref={frameRef}
          className={s.frame}
          data-tour="dome"
          tabIndex={view ? 0 : -1}
          role="application"
          aria-label="SPHEREx image. Use arrow keys to move the cursor and Enter to measure."
          onKeyDown={(e) => {
            if (!view) return;
            const { nx, ny } = view.manifest.grid;
            const cur = props.sel ?? [nx >> 1, ny >> 1];
            const d: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] };
            if (d[e.key]) {
              e.preventDefault();
              e.stopPropagation();
              const step = e.shiftKey ? 5 : 1;
              props.onCursor([
                Math.min(nx - 1, Math.max(0, cur[0] + d[e.key][0] * step)),
                Math.min(ny - 1, Math.max(0, cur[1] + d[e.key][1] * step)),
              ]);
            } else if (e.key === "Enter") {
              e.preventDefault();
              props.onSelect(cur);
            }
          }}
          onClick={(e) => {
            if (!view) return;
            const r = e.currentTarget.getBoundingClientRect();
            const u = (e.clientX - r.left) / r.width;
            const v = (e.clientY - r.top) / r.height;
            if ((u - 0.5) ** 2 + (v - 0.5) ** 2 > 0.25) return; // outside the dome
            const { nx, ny } = view.manifest.grid;
            props.onSelect([Math.min(nx - 1, Math.floor(u * nx)), Math.min(ny - 1, ny - 1 - Math.floor(v * ny))]);
          }}
        >
          {view ? (
            <>
              <FrameCanvas view={view} index={index} mode={mode} stretch={props.stretch} invert={props.invert} smooth={props.smooth} gain={props.gain} refIndex={props.refIndex} />
              <OverlayLayer
                nx={view.manifest.grid.nx}
                ny={view.manifest.grid.ny}
                mask={props.overlays.flags ? (view.masks[index] ?? null) : null}
              />
              {inner && box && (
                <svg className={s.overlay} viewBox={`0 0 ${box.side} ${box.side}`} aria-hidden="true">
                  {inner.lines.map((l, i) => (
                    <path key={i} d={l.d} className={s.gridOnImage} />
                  ))}
                </svg>
              )}
              <Crosshair />
              {props.sel && <SelectionMarker sel={props.sel} nx={view.manifest.grid.nx} ny={view.manifest.grid.ny} />}
            </>
          ) : (
            props.children
          )}
        </div>
        <div className={s.bottomRow} />
      </div>

      {showLabel && box && (
        <TargetLabel
          className={s.labelIn}
          left={box.left + box.side / 2 + (box.side / 2 + 36) * 0.7071 + 60}
          top={box.top + box.side / 2 - (box.side / 2 + 36) * 0.7071 - 20}
          maxWidth={Math.min(280, labelRoom)}
          name={props.target?.name ?? "Custom position"}
          ra={ra}
          dec={dec}
          sub={props.target?.watch ?? null}
          fixture={view?.label ?? null}
          provenance={view?.manifest.origin ? `SPHEREx Level 2 · ${view.manifest.origin.kind === "saved" ? "Saved cutouts" : "Live archive"} · North up · East left` : null}
        />
      )}
    </>
  );
}

/** Planetarium rim: an atmosphere glow, a position-angle ring with ticks every 5°, and N/E/S/W (east left). */
function DomeRing({ left, top, side }: { left: number; top: number; side: number }) {
  const cx = left + side / 2;
  const cy = top + side / 2;
  const r = side / 2;
  const ring = r + 10;
  const ticks = Array.from({ length: 72 }, (_, i) => {
    const pa = i * 5; // degrees east of north
    const a = (pa * Math.PI) / 180;
    const len = pa % 30 === 0 ? 8 : 4;
    // North up, east left: screen angle measured from up, counter-clockwise.
    const sx = Math.sin(a);
    const sy = Math.cos(a);
    return `M${cx - sx * ring},${cy - sy * ring}L${cx - sx * (ring + len)},${cy - sy * (ring + len)}`;
  }).join("");
  const letters: [string, number][] = [
    ["N", 0],
    ["E", 90],
    ["S", 180],
    ["W", 270],
  ];
  return (
    <g>
      <defs>
        <radialGradient id="atmo" cx={cx} cy={cy} r={r + 70} gradientUnits="userSpaceOnUse">
          <stop offset={r / (r + 70)} stopColor="var(--sky-band)" stopOpacity="0.28" />
          <stop offset="1" stopColor="var(--sky-band)" stopOpacity="0" />
        </radialGradient>
      </defs>
      <circle cx={cx} cy={cy} r={r + 70} fill="url(#atmo)" />
      <circle cx={cx} cy={cy} r={ring} className={s.ringLine} />
      <path d={ticks} className={s.ticks} />
      {letters.map(([t, pa]) => {
        const a = (pa * Math.PI) / 180;
        return (
          <text
            key={t}
            x={cx - Math.sin(a) * (ring + 22)}
            y={cy - Math.cos(a) * (ring + 22)}
            className={s.cardinal}
            textAnchor="middle"
            dominantBaseline="central"
          >
            {t}
          </text>
        );
      })}
    </g>
  );
}

function SelectionMarker({ sel, nx, ny }: { sel: [number, number]; nx: number; ny: number }) {
  const x = sel[0] + 0.5;
  const y = ny - sel[1] - 0.5;
  return (
    <svg className={s.overlay} viewBox={`0 0 ${nx} ${ny}`} aria-hidden="true">
      <circle cx={x} cy={y} r={1.8} fill="none" stroke="var(--accent)" strokeWidth={0.25} />
      <path d={`M${x - 3},${y}h1.2M${x + 1.8},${y}h1.2M${x},${y - 3}v1.2M${x},${y + 1.8}v1.2`} stroke="var(--accent)" strokeWidth={0.25} />
    </svg>
  );
}

function Leader({ left, top, side }: { left: number; top: number; side: number }) {
  const cx = left + side / 2;
  const cy = top + side / 2;
  const r = side / 2 + 36;
  const sx = cx + r * 0.7071;
  const sy = cy - r * 0.7071;
  const ex = sx + 34;
  const ey = sy - 34;
  return (
    <g className={s.leader}>
      <path d={`M${sx},${sy}L${ex},${ey}H${ex + 18}`} />
      <circle cx={ex + 18} cy={ey} r={2} />
    </g>
  );
}

function TargetLabel(p: {
  className: string;
  left: number;
  top: number;
  maxWidth: number;
  name: string;
  ra: number | null;
  dec: number | null;
  sub: string | null;
  fixture: string | null;
  provenance: string | null;
}) {
  return (
    <div className={`${s.targetLabel} ${p.className}`} style={{ left: p.left, top: p.top, maxWidth: p.maxWidth }}>
      <span className={`display ${s.targetName}`}>{p.name}</span>
      {p.ra !== null && p.dec !== null && (
        <span className={`mono ${s.targetCoords}`}>
          <span>
            RA <b>{formatRa(p.ra)}</b>
          </span>
          <span>
            DEC <b>{formatDec(p.dec)}</b>
          </span>
        </span>
      )}
      {p.sub && <span className={s.targetSub}>{p.sub}</span>}
      {p.provenance && <span className={`mono ${s.provenance}`}>{p.provenance}</span>}
      {p.fixture && <span className={`mono ${s.sourceTag}`}>{p.fixture}</span>}
    </div>
  );
}

function ScaleBar({ side, fovArcmin }: { side: number; fovArcmin: number }) {
  const px = side / fovArcmin;
  if (!px) return <span />;
  return (
    <span className={s.scale}>
      <span className={s.scaleBar} style={{ width: px }} />1′
    </span>
  );
}

function Loading({ load }: { load: Extract<LoadState, { kind: "loading" }> }) {
  const p = load.progress;
  const line = p ? `${p.stage.toUpperCase()}${p.done !== undefined && p.total ? ` ${p.done} / ${p.total}` : ""}` : "Loading";
  return (
    <div className={s.loading} role="status" aria-live="polite" aria-label={`Loading sky image: ${line.toLowerCase()}`}>
      <div className={s.skeleton} />
      <span className={`${s.progress} mono`}>{line}</span>
    </div>
  );
}

function ErrorCard({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <GlassPanel strong className={s.card} role="alert">
      <p>{message}</p>
      <GlassButton icon="retry" onClick={onRetry}>
        Retry
      </GlassButton>
    </GlassPanel>
  );
}

function NoCoverage({ onRetry }: { onRetry: () => void }) {
  return (
    <GlassPanel strong className={s.card} role="status">
      <p>No SPHEREx passes here yet. Try another position or check again later.</p>
      <GlassButton icon="retry" onClick={onRetry}>
        Check again
      </GlassButton>
    </GlassPanel>
  );
}

interface CanvasProps {
  view: LoadedView;
  index: number;
  mode: ViewMode;
  stretch: StretchKind;
  invert: boolean;
  smooth: boolean;
  gain: number;
  refIndex: number;
}

/** Display upscale for smoothing: the 59 x 59 grid is drawn into a ~1000 px canvas with bilinear filtering. */
const UPSCALE_TARGET = 512;

function FrameCanvas({ view, index, mode, stretch, invert, smooth, gain, refIndex }: CanvasProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  const { manifest: m, images } = view;
  const { nx, ny } = m.grid;
  const k = smooth ? Math.max(1, Math.ceil(UPSCALE_TARGET / Math.max(nx, ny))) : 1;

  useEffect(() => {
    const cv = ref.current;
    const ctx = cv?.getContext("2d");
    if (!cv || !ctx) return;
    markFlight("image-render-start");
    const src = document.createElement("canvas");
    src.width = nx;
    src.height = ny;
    const sctx = src.getContext("2d");
    if (!sctx) return;
    const out = sctx.createImageData(nx, ny);
    const cur = images[index] ?? images[0];
    const r = Math.min(refIndex, images.length - 1);
    if (mode === "diff" && images.length > 1 && index !== r) {
      renderDifference(out.data, images[r], cur, m.epochs[index].phot_scale / m.epochs[r].phot_scale, nx, ny, {
        neg: tokenRgb("--text-1"),
        pos: tokenRgb("--mover"),
      });
    } else {
      renderEpoch(out.data, cur, nx, ny, m.stretch, stretch, invert, gain);
    }
    sctx.putImageData(out, 0, 0);
    ctx.imageSmoothingEnabled = smooth;
    ctx.imageSmoothingQuality = "high";
    ctx.clearRect(0, 0, cv.width, cv.height);
    markFlight("image-upload-start");
    ctx.drawImage(src, 0, 0, cv.width, cv.height);
    markFlight("image-upload-end");
  }, [images, index, mode, stretch, invert, smooth, gain, refIndex, nx, ny, m, k]);

  const e = m.epochs[index] ?? m.epochs[0];
  return (
    <canvas
      ref={ref}
      className={s.canvas}
      data-smooth={smooth}
      width={nx * k}
      height={ny * k}
      role="img"
      aria-label={`SPHEREx image, epoch ${e.i + 1} of ${m.epochs.length}, ${e.label}${mode === "diff" ? `, difference from pass ${Math.min(refIndex, m.epochs.length - 1) + 1}` : ""}`}
    />
  );
}

/** Thin ring with a clear centre so it never hides the target. */
function Crosshair() {
  return (
    <svg className={s.overlay} viewBox="0 0 100 100" aria-hidden="true">
      <g fill="none" stroke="var(--text-1)" strokeOpacity="0.7" strokeWidth="0.35">
        <circle cx="50" cy="50" r="7" />
        <path d="M50 38v6M50 56v6M38 50h6M56 50h6" />
      </g>
    </svg>
  );
}

interface OverlayProps {
  nx: number;
  ny: number;
  mask: Uint8Array | null;
}

/** Flag boxes draw only when mask data exists. */
function OverlayLayer({ nx, ny, mask }: OverlayProps) {
  if (!mask) return null;
  const flagged: [number, number][] = [];
  if (mask) {
    for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) if (mask[(ny - 1 - y) * nx + x]) flagged.push([x, y]);
  }
  return (
    <svg className={s.overlay} viewBox={`0 0 ${nx} ${ny}`} aria-hidden="true">
      {flagged.map(([x, y]) => (
        <g key={`${x}-${y}`} stroke="var(--flag)" strokeWidth={0.12} fill="none">
          <rect x={x + 0.1} y={y + 0.1} width={0.8} height={0.8} />
          <path d={`M${x + 0.1},${y + 0.9}L${x + 0.9},${y + 0.1}`} />
        </g>
      ))}
    </svg>
  );
}
