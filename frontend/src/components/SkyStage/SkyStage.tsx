import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import type { LoadedView } from "../../data/source";
import type { ViewState as LoadState } from "../../hooks/useView";
import { flightIsActive, getFlightDirection, getFlightStartPose, markFlight, registerDomeLayout, setDomeDestination, subscribeFlight, type FlightPose } from "../../lib/flight";
import { formatDec, formatRa } from "../../lib/format";
import { ARROW_GAIN, gaiaMarks } from "../../lib/gaia";
import { renderDifference, renderEpoch, tokenRgb } from "../../lib/stretch";
import type { Preset } from "../../lib/targets";
import { differenceLabel, loadingPresentation, savedPresetLink, savedRecovery, sourcePresentation, viewErrorCopy } from "../../lib/viewPresentation";
import type { Overlays, StretchKind, ViewMode } from "../../lib/url";
import type { CatalogObject, FovArcmin, GaiaResult } from "../../types";
import { Orrery } from "../Orrery/Orrery";
import { GlassButton, GlassPanel, Icon, Term } from "../glass";
import { buildGrid } from "./grid";
import s from "./SkyStage.module.css";

interface SkyStageProps {
  visibleIds?: ReadonlySet<string> | null;
  catalogObjects: readonly CatalogObject[];
  point: CatalogObject | null;
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
  overlays: Overlays;
  flying: boolean;
  onFullscreen: () => void;
  /** Show the leader-line label beside the dome (hidden when a panel covers it). */
  showLabel: boolean;
  /** Selected grid pixel, FITS orientation (row 0 = south). */
  sel: [number, number] | null;
  onSelect: (xy: [number, number] | null) => void;
  onRetry: () => void;
  onPreset: (p: Preset) => void;
  onOpenFromHome: (p: CatalogObject, from: { x: number; y: number } | null) => void;
  onFlightStart: (p: CatalogObject) => void;
  onFlightEnd: () => void;
  /** Move the measuring cursor without opening the drawer (keyboard). */
  onCursor: (xy: [number, number]) => void;
  onTour: () => void;
}

export function SkyStage(props: SkyStageProps) {
  const { load } = props;
  useEffect(() => {
    if (load.kind === "ready") markFlight("data-ready");
  }, [load.kind]);
  const home = load.kind === "idle";
  const empty = load.kind === "ready" && load.view.manifest.epochs.length === 0;
  return (
    <>
      <div className={s.homeLayer} data-home={home}>
        <Home visibleIds={props.visibleIds ?? null} active={home} targets={props.catalogObjects} onPick={props.onOpenFromHome} onFlightStart={props.onFlightStart} onFlightEnd={props.onFlightEnd} onTour={props.onTour} flying={props.flying} onFullscreen={props.onFullscreen} />
      </div>
      <section className={s.stage} aria-label="Sky view" data-preparing={home} aria-hidden={home} inert={home}>
        {load.kind === "error" && <ErrorCard code={load.code} recovery={savedRecovery(props.ra, props.dec)} message={load.message} onRetry={props.onRetry} />}
        {empty && <NoCoverage onRetry={props.onRetry} />}
        {(home || load.kind === "loading" || (load.kind === "ready" && !empty)) && (
          <Eyepiece {...props} view={load.kind === "ready" ? load.view : null} />
        )}
        {load.kind === "loading" && <Loading load={load} recovery={savedRecovery(props.ra, props.dec)} />}
      </section>
    </>
  );
}

/** First visit: a live holographic orrery, with the five targets on the sky around the solar system. */
function Home({
  active,
  targets,
  visibleIds,
  onPick,
  onFlightStart,
  onFlightEnd,
  flying,
  onFullscreen,
}: {
  active: boolean;
  targets: readonly CatalogObject[];
  visibleIds: ReadonlySet<string> | null;
  onPick: (p: CatalogObject, from: { x: number; y: number } | null) => void;
  onFlightStart: (p: CatalogObject) => void;
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
          active={active}
          targets={targets}
          visibleIds={visibleIds}
          onPick={onPick}
          onFlightStart={onFlightStart}
          onFlightEnd={onFlightEnd}
        />
      </div>
      <div className={s.zoomControls} aria-label="Orrery zoom controls" data-tour="orrery-zoom" data-flight-hide inert={flying}>
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
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      // Local geometry never includes the flight or drawer transform.
      const side = parseFloat(getComputedStyle(el).width);
      setBox((prev) => prev && prev.side === side && prev.vw === innerWidth && prev.vh === innerHeight
        ? prev : { left: 0, top: 0, side, vw: innerWidth, vh: innerHeight });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    window.addEventListener("resize", measure);
    return () => { ro.disconnect(); window.removeEventListener("resize", measure); };
  }, []);
  return [ref, box] as const;
}

/** Every visible part of the eyepiece shares this one coordinate system and transform. */
function Eyepiece(props: SkyStageProps & { view: LoadedView | null; children?: ReactNode }) {
  const { view, ra, dec, index, mode } = props;
  const [frameRef, box] = useBox<HTMLDivElement>();
  const columnRef = useRef<HTMLDivElement>(null);
  const previousLayout = useRef<FlightPose | null>(null);
  const flip = useRef<Animation | null>(null);
  const layout = useRef<FlightPose | null>(null);
  const labelRef = useRef<HTMLDivElement>(null);
  const labelMotion = useRef<Animation | null>(null);
  const absorption = useRef<{ animations: Animation[]; reduced: boolean; hidden: boolean } | null>(null);
  const labelLayout = useRef<{ left: number; top: number; width: number; height: number; hidden: boolean } | null>(null);

  useLayoutEffect(() => {
    const col = columnRef.current, frame = frameRef.current;
    if (!col || !frame) return;
    const r = frame.getBoundingClientRect();
    const destination = { x: r.left + r.width / 2, y: r.top + r.height / 2, side: r.width };
    layout.current = destination;
    setDomeDestination(destination);
    const apply = (pose: FlightPose) => {
      const base = layout.current ?? destination;
      col.style.transform = `translate3d(${pose.x - base.x}px, ${pose.y - base.y}px, 0) scale(${pose.side / base.side})`;
    };
    const unregister = registerDomeLayout(() => {
      col.style.removeProperty("transform");
      const r = frame.getBoundingClientRect();
      const base = { x: r.left + r.width / 2, y: r.top + r.height / 2, side: r.width };
      layout.current = base;
      if (getFlightDirection() === 1) setDomeDestination(base);
    });
    const unsubscribe = subscribeFlight((sample) => {
      if (sample.progress === 0) flip.current?.cancel();
      col.dataset.flight = sample.reduced ? "reduced" : sample.direction === 1 ? "forward" : "return";
      if (sample.reduced) {
        col.style.opacity = String(sample.direction === 1 ? sample.progress : 1 - sample.progress);
      } else apply(sample.pose);
      if (sample.progress === 1 && sample.direction === 1) {
        delete col.dataset.flight;
        col.style.removeProperty("transform");
        col.style.removeProperty("opacity");
      }
    });
    return () => {
      unsubscribe();
      unregister();
      flip.current?.cancel();
      labelMotion.current?.cancel();
      absorption.current?.animations.forEach(animation => animation.cancel());
      absorption.current = null;
      col.style.removeProperty("transform");
      col.style.removeProperty("opacity");
      delete col.dataset.flight;
    };
  }, [frameRef]);

  // Pre-mounted geometry is measured in its new layout before the flight clock starts.
  useLayoutEffect(() => {
    const col = columnRef.current, frame = frameRef.current;
    if (!col || !frame || !props.flying || !flightIsActive()) return;
    flip.current?.cancel();
    col.style.removeProperty("transform");
    const r = frame.getBoundingClientRect();
    const base = { x: r.left + r.width / 2, y: r.top + r.height / 2, side: r.width };
    layout.current = base;
    if (getFlightDirection() === 1) setDomeDestination(base);
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    col.dataset.flight = reduced ? "reduced" : getFlightDirection() === 1 ? "forward" : "return";
    const start = getFlightStartPose();
    if (start && !reduced) col.style.transform = `translate3d(${start.x - base.x}px, ${start.y - base.y}px, 0) scale(${start.side / base.side})`;
    if (reduced) col.style.opacity = getFlightDirection() === 1 ? "0" : "1";
  }, [frameRef, props.flying, props.ra, props.dec]);

  // Read interrupted poses before cancelling either animation, then invert the new layout.
  useLayoutEffect(() => {
    const col = columnRef.current, frame = frameRef.current, label = labelRef.current;
    if (!col || !frame || props.load.kind === "idle" || props.flying || flightIsActive()) {
      previousLayout.current = null;
      labelLayout.current = null;
      return;
    }
    const previous = previousLayout.current;
    const matrix = new DOMMatrixReadOnly(getComputedStyle(col).transform);
    const visible = previous ? { x: previous.x + matrix.e, y: previous.y + matrix.f, side: previous.side * matrix.a } : null;
    const bounds = frame.getBoundingClientRect();
    const oldLabel = labelLayout.current;
    const anchor = label ? { left: label.offsetLeft, top: label.offsetTop - 14, width: label.offsetWidth, height: label.offsetHeight, hidden: !props.showLabel } : null;
    const sameLabel = !anchor ? !oldLabel : oldLabel && Object.keys(anchor).every(key => anchor[key as keyof typeof anchor] === oldLabel[key as keyof typeof anchor]);
    // Observer renders must not restart the drawer clock when the visible layout is unchanged.
    if (visible && sameLabel && Math.abs(bounds.x + bounds.width / 2 - visible.x) + Math.abs(bounds.y + bounds.height / 2 - visible.y) + Math.abs(bounds.width - visible.side) < 0.1) return;
    const labelMatrix = new DOMMatrixReadOnly(label ? getComputedStyle(label).transform : "none");
    const row = frame.offsetTop;
    const labelPose = previous && visible && oldLabel ? {
      x: visible.x + (oldLabel.left - previous.side / 2 + labelMatrix.e) * matrix.a,
      y: visible.y + (oldLabel.top - previous.side / 2 - row + labelMatrix.f) * matrix.a,
      scale: labelMatrix.a * matrix.a,
    } : null;
    flip.current?.cancel();
    const r = frame.getBoundingClientRect();
    const next = { x: r.left + r.width / 2, y: r.top + r.height / 2, side: r.width };
    previousLayout.current = next;
    layout.current = next;
    setDomeDestination(next);
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const theme = getComputedStyle(col);
    const fullDuration = parseFloat(theme.getPropertyValue("--dur"));
    const time = Number(absorption.current?.animations[0].currentTime ?? 0);
    const reversing = oldLabel && oldLabel.hidden !== !props.showLabel && absorption.current;
    const duration = reversing ? Math.max(1, props.showLabel ? time : fullDuration - time) : fullDuration;
    const easing = theme.getPropertyValue("--ease").trim();
    const changed = visible && Math.abs(visible.x - next.x) + Math.abs(visible.y - next.y) + Math.abs(visible.side - next.side) >= 0.1;
    if (changed && !reduced) {
      flip.current = col.animate([
        { transform: `translate3d(${visible.x - next.x}px, ${visible.y - next.y}px, 0) scale(${visible.side / next.side})` },
        { transform: "translate3d(0, 0, 0) scale(1)" },
      ], { duration, easing });
    }
    if (!label || !anchor) { labelLayout.current = null; return; }
    const parent = new DOMMatrixReadOnly(getComputedStyle(col).transform);
    const start = labelPose && !reduced
      ? `translate(${(labelPose.x - next.x - parent.e) / parent.a + next.side / 2 - anchor.left}px, ${(labelPose.y - next.y - parent.f) / parent.a + next.side / 2 + row - anchor.top}px) scale(${labelPose.scale / parent.a})`
      : "translate(0, 0) scale(1)";
    labelMotion.current?.cancel();
    labelLayout.current = anchor;
    if (labelPose && !reduced) {
      labelMotion.current = label.animate([
        { transform: start },
        { transform: "translate(0, 0) scale(1)" },
      ], { duration, easing });
    }
  });
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
  const labelRoom = box ? (box.vw - box.side) / 2 - 150 : 0;
  const showLabel = labelRoom > 160 && box !== null;

  useLayoutEffect(() => {
    const label = labelRef.current;
    const leader = columnRef.current?.querySelector<SVGGElement>("[data-label-leader]");
    if (!label || !leader) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const hidden = !props.showLabel;
    const lines = Array.from(label.children) as HTMLElement[];
    const targets = reduced ? [label, leader] : [...lines.flatMap(line => [line, line.firstElementChild!]), ...leader.children];
    let motion = absorption.current;
    if (!motion || motion.reduced !== reduced || targets.length !== motion.animations.length ||
      targets.some((target, i) => (motion!.animations[i].effect as KeyframeEffect).target !== target)) {
      const duration = reduced ? 150 : 360;
      const time = motion ? Number(motion.animations[0].currentTime) / (motion.reduced ? 150 : 360) * duration : hidden ? duration : 0;
      motion?.animations.forEach(animation => animation.cancel());
      const animations = targets.map((target, i) => {
        let frames: Keyframe[];
        if (reduced) frames = [{ opacity: 1 }, { opacity: 0 }];
        else if (i < lines.length * 2) {
          const line = lines[Math.floor(i / 2)];
          const content = i % 2 === 1;
          const start = Math.min(Math.floor(i / 2) * 0.035, 0.16);
          // Opposing translations wipe from the right without repainting a text clip-path.
          const from = content ? "translateX(0%)" : "translate(0, 0) scale(1) translateX(0%)";
          const to = content ? "translateX(100%)" : `translate(-8px, ${40 - line.offsetTop}px) scale(0.06) translateX(-100%)`;
          frames = [
            { offset: 0, transform: from, opacity: 1 },
            { offset: start, transform: from, opacity: 1, easing: "cubic-bezier(0.42, 0, 1, 1)" },
            { offset: 0.68 + start, transform: to, opacity: content ? 1 : 0 },
            { offset: 1, transform: to, opacity: content ? 1 : 0 },
          ];
        } else if (target.tagName === "path") {
          frames = [{ offset: 0, strokeDashoffset: 0 }, { offset: 0.82, strokeDashoffset: 0, easing: "cubic-bezier(0.42, 0, 1, 1)" }, { strokeDashoffset: 1 }];
        } else {
          frames = [{ offset: 0, opacity: 1 }, { offset: 0.8, opacity: 1 }, { offset: 0.82, opacity: 0 }, { opacity: 0 }];
        }
        const animation = target.animate(frames, { duration, fill: "both" });
        animation.pause();
        animation.currentTime = time;
        return animation;
      });
      motion = { animations, reduced, hidden: motion?.hidden ?? hidden };
      if (time > 0 && time < duration) animations.forEach(animation => {
        animation.playbackRate = hidden ? 1 : -1;
        animation.play();
      });
      absorption.current = motion;
    }
    // Keep one playhead per part: changing direction preserves the exact interrupted pose.
    motion.animations.forEach(animation => {
      if (motion.hidden !== hidden) {
        const time = Number(animation.currentTime);
        animation.playbackRate = hidden ? 1 : -1;
        const duration = Number(animation.effect!.getTiming().duration);
        if (hidden ? time >= duration : time <= 0) animation.pause();
        else animation.play();
      }
    });
    motion.hidden = hidden;
  });

  return (
    <div ref={columnRef} className={s.column} data-details={!props.showLabel} data-eyepiece>
      {box && outer && (
        <svg
          className={s.sky}
          viewBox={`0 0 ${box.side} ${box.side}`}
          width="100%"
          aria-hidden="true"
        >
          <defs>
            <mask id="frame-hole">
              <rect x={-box.vw} y={-box.vh} width={box.vw * 3} height={box.vh * 3} fill="white" />
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

      <div className={s.imageColumn}>
        {!showLabel && props.showLabel && props.point && !props.target && <div className={s.pointHeading}>
          <span className="display">{props.point.name}</span>
          <span className="micro">{props.point.kind.replaceAll("_", " ")}</span>
        </div>}
        <div className={`${s.topRow} mono`}>
          <ScaleBar side={box?.side ?? 0} fovArcmin={fovArcmin} />
          {diff ? (
            <span className={s.legend} aria-label="Difference: silver was, amber is now">
              <Term term="Difference pair" className={s.legendTerm}>
                <span>
                  <span className={s.swatchNeg} />
                  Was −
                </span>
                {" "}
                <span>
                  <span className={s.swatchPos} />
                  Now +
                </span>
              </Term>
            </span>
          ) : m && m.epochs.length === 1 ? (
            <span>One pass</span>
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
              {props.overlays.gaia && view.gaia && <GaiaLayer gaia={view.gaia} index={index} nx={view.manifest.grid.nx} ny={view.manifest.grid.ny} />}
              <Crosshair />
              {props.sel && <SelectionMarker sel={props.sel} nx={view.manifest.grid.nx} ny={view.manifest.grid.ny} />}
            </>
          ) : (
            props.children
          )}
        </div>
        <div className={s.bottomRow}>
          {view && props.showLabel && <span className={s.sourceBadge} title={sourcePresentation(view).note}>{sourcePresentation(view).label} · {sourcePresentation(view).cache}</span>}
          {m?.epochs.length === 1 && props.showLabel && <p className={s.singlePass} role="status">One pass. Motion needs at least two passes.</p>}
          {!showLabel && (!outer || outer.raLabels.length === 0) && ra !== null && dec !== null && (
            <span className={`${s.positionReadout} mono`}>RA {formatRa(ra)} <span>DEC {formatDec(dec)}</span></span>
          )}
        </div>
      </div>

      {showLabel && box && (
        <TargetLabel
          ref={labelRef}
          hidden={!props.showLabel}
          name={props.target?.name ?? props.point?.name ?? "Custom position"}
          ra={ra}
          dec={dec}
          sub={props.target?.watch ?? props.point?.kind.replaceAll("_", " ") ?? null}
          fixture={view?.label ?? null}
          provenance={view ? `${sourcePresentation(view).label} · North up · East left` : null}
        />
      )}
    </div>
  );
}

/** One hairline rim, with north up and east left. */
function DomeRing({ left, top, side }: { left: number; top: number; side: number }) {
  const cx = left + side / 2, cy = top + side / 2, r = side / 2 + 10;
  return (
    <g data-dome-ring>
      <circle cx={cx} cy={cy} r={r} className={s.ringLine} />
      <path d={`M${cx},${cy - r}v-7M${cx - r},${cy}h-7`} className={s.ticks} />
      <text x={cx} y={cy - r - 18} className={s.cardinal} textAnchor="middle" dominantBaseline="central">N</text>
      <text x={cx - r - 20} y={cy} className={s.cardinal} textAnchor="middle" dominantBaseline="central">E</text>
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

/** Gaia DR3 predictions for this pass: green ring = SPHEREx sees the star there, dashed = it does not. */
function GaiaLayer({ gaia, index, nx, ny }: { gaia: GaiaResult; index: number; nx: number; ny: number }) {
  const marks = useMemo(() => gaiaMarks(gaia, index, ny), [gaia, index, ny]);
  return (
    <svg className={s.overlay} viewBox={`0 0 ${nx} ${ny}`} aria-hidden="true">
      {marks.map((m, i) => (
        <circle key={i} cx={m.x} cy={m.y} r={1.3} className={m.matched ? s.gaiaMatch : s.gaiaMiss} />
      ))}
      {marks.map(
        (m, i) =>
          m.arrow && (
            <g key={`a${i}`} className={s.gaiaArrow}>
              <line x1={m.arrow[0]} y1={m.arrow[1]} x2={m.arrow[2]} y2={m.arrow[3]} />
              <circle cx={m.arrow[2]} cy={m.arrow[3]} r={0.45} />
              <text x={m.arrow[2] + 1} y={m.arrow[3]}>
                Gaia motion ×{ARROW_GAIN}
              </text>
            </g>
          ),
      )}
    </svg>
  );
}

function Leader({ left, top, side }: { left: number; top: number; side: number }) {
  const cx = left + side / 2;
  const cy = top + side / 2;
  const r = side / 2 + 36;
  const sx = cx + (side / 2 + 10) * 0.7071;
  const sy = cy - (side / 2 + 10) * 0.7071;
  const ex = cx + r * 0.7071 + 34;
  const ey = cy - r * 0.7071 - 34;
  return (
    <g className={s.leader} data-label-leader>
      <path pathLength={1} d={`M${sx},${sy}L${ex},${ey}H${ex + 18}`} />
      <circle cx={ex + 18} cy={ey} r={2} />
    </g>
  );
}

function TargetLabel({ ref, ...p }: {
  ref: RefObject<HTMLDivElement | null>;
  hidden: boolean;
  name: string;
  ra: number | null;
  dec: number | null;
  sub: string | null;
  fixture: string | null;
  provenance: string | null;
}) {
  return (
    <div ref={ref} className={s.targetLabel} data-target-label aria-hidden={p.hidden} inert={p.hidden}>
      <span className={s.labelLine}><span className={`display ${s.targetName}`}>{p.name}</span></span>
      {p.ra !== null && p.dec !== null && (
        <span className={s.labelLine}>
          <span className={`mono ${s.targetCoords}`}>
            <span>
              RA <b>{formatRa(p.ra)}</b>
            </span>
            <span>
              DEC <b>{formatDec(p.dec)}</b>
            </span>
          </span>
        </span>
      )}
      {p.sub && <span className={s.labelLine}><span className={s.targetSub}>{p.sub}</span></span>}
      {p.provenance && <span className={s.labelLine}><span className={`mono ${s.provenance}`}>{p.provenance}</span></span>}
      {p.fixture && <span className={s.labelLine}><span className={`mono ${s.sourceTag}`}>{p.fixture}</span></span>}
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

function Loading({ load, recovery }: { load: Extract<LoadState, { kind: "loading" }>; recovery?: Preset }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const elapsed = Math.max(0, Math.floor((now - (load.progress?.startedAtMs ?? now)) / 1000));
  const copy = loadingPresentation(load.progress, elapsed);
  return (
    <GlassPanel strong className={s.loading}>
      <div className={s.progress}>
        <strong role="status" aria-live="polite">{copy.title}</strong>
        <p>{copy.detail}</p>
        <span className="mono" aria-live="off">{elapsed}s elapsed</span>
        {copy.waiting && <p>{copy.waiting}</p>}
        {elapsed >= 30 && (recovery ? <a href={savedPresetLink(recovery)}>Open saved default: {recovery.name}</a>
          : <a href="/learn.html">Explore saved examples</a>)}
      </div>
    </GlassPanel>
  );
}

function ErrorCard({ code, message, recovery, onRetry }: { code: string; message: string; recovery?: Preset; onRetry: () => void }) {
  const copy = viewErrorCopy(code);
  const offerSaved = recovery && (code === "IRSA_DOWN" || code === "QUEUE_FULL" || code === "HTTP_429" || code === "NOT_SAVED");
  return (
    <GlassPanel strong className={s.card} role="alert">
      <h2>{copy.title}</h2>
      <p>{message}</p>
      <p>{copy.advice}</p>
      <GlassButton icon="retry" onClick={onRetry}>
        Retry
      </GlassButton>
      {offerSaved && <div className={s.recovery}>
        <a href={savedPresetLink(recovery)}>Open saved default: {recovery.name}</a>
        <p>This opens the bundled {recovery.fov}′ / {recovery.band} view at its default position, resets the pass and selection, and uses Saved data.</p>
      </div>}
      {!offerSaved && <a className={s.savedExamples} href="/learn.html">Explore saved examples</a>}
    </GlassPanel>
  );
}

function NoCoverage({ onRetry }: { onRetry: () => void }) {
  return (
    <GlassPanel strong className={s.card} role="status">
      <h2>No usable passes for this view</h2>
      <p>This selection produced no usable passes. Try another band, field of view or position. This does not establish that the archive has no observations here.</p>
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
    cv.dataset.ready = "true";
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
      aria-label={`SPHEREx image, epoch ${e.i + 1} of ${m.epochs.length}, ${e.label}${differenceLabel(mode, images.length, index, refIndex)}`}
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
