import { useEffect, useRef } from "react";
import { flightIsActive, getHomeCamera, markFlight, subscribeFlight } from "../../lib/flight";
import { drawStarfield, loadStarfield, type Starfield } from "../../lib/starfield";
import s from "./SkyBackdrop.module.css";

const NEAR = 0.04;

/**
 * BSC5 catalogue directions, visual magnitudes and B-V colours behind the science dome.
 * The warp is decorative: its synthetic travel depths are not stellar distances.
 * The shared flight clock supplies position, direction and speed.
 */
export function SkyBackdrop({ dim }: { dim: boolean }) {
  const backdropRef = useRef<HTMLDivElement>(null);
  const ref = useRef<HTMLCanvasElement>(null);
  const prepare = useRef<() => void>(() => {});
  const draw = useRef<(streak: number, travel?: number) => void>(() => {});
  const settle = useRef<(travel: number) => void>(() => {});
  /** Current vanishing point in canvas pixels (NaN = canvas centre). */
  const focus = useRef({ x: NaN, y: NaN });

  // Build the field and the painter once; repaint on resize.
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    let field: Starfield | null = null;
    let geometry = new Float32Array(0);
    let projected = new Float32Array(0);
    let disposed = false;
    let w = 0;
    let h = 0;
    let pixelWidth = 0;
    let pixelHeight = 0;
    let bitmapDpr = 0;
    let viewportWidth = window.innerWidth;
    let viewportHeight = window.innerHeight;
    const resize = () => {
      const dpr = Math.min(1.5, window.devicePixelRatio || 1);
      const nextWidth = viewportWidth + 48;
      const nextHeight = viewportHeight + 48;
      const nextPixelWidth = Math.round(nextWidth * dpr);
      const nextPixelHeight = Math.round(nextHeight * dpr);
      if (nextPixelWidth === pixelWidth && nextPixelHeight === pixelHeight && bitmapDpr === dpr) return;
      markFlight("backdrop-resize");
      w = nextWidth;
      h = nextHeight;
      pixelWidth = nextPixelWidth;
      pixelHeight = nextPixelHeight;
      bitmapDpr = dpr;
      if (cv.width !== pixelWidth) cv.width = pixelWidth;
      if (cv.height !== pixelHeight) cv.height = pixelHeight;
      cv.style.width = `${w}px`;
      cv.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      draw.current(0);
    };
    // Catalogue directions are real; the warp's depth and travel are cinematic, not distances.
    prepare.current = () => {
      if (!field) return;
      const camera = getHomeCamera();
      const cy = Math.cos(camera.yaw), sy = Math.sin(camera.yaw);
      const cp = Math.cos(camera.pitch), sp = Math.sin(camera.pitch);
      for (let i = 0; i < field.xyz.length; i += 3) {
        const xyz = field.xyz;
        const x = xyz[i] * cy - xyz[i + 1] * sy;
        const y = xyz[i] * sy + xyz[i + 1] * cy;
        const depth = y * cp - xyz[i + 2] * sp;
        const z = NEAR + Math.max(0, depth) * (1 - NEAR);
        geometry[i] = x * z / depth;
        geometry[i + 1] = -(y * sp + xyz[i + 2] * cp) * z / depth;
        geometry[i + 2] = depth > 0.04 ? z : -1;
      }
    };
    draw.current = (streak: number, travel = 0) => {
      ctx.setTransform(cv.width / w, 0, 0, cv.height / h, 0, 0);
      ctx.clearRect(0, 0, w, h);
      if (!field) return;
      const cx = Number.isFinite(focus.current.x) ? focus.current.x : w / 2;
      const cy = Number.isFinite(focus.current.y) ? focus.current.y : h / 2;
      const f = Math.max(w, h) * 0.5;
      const moving = Math.abs(streak) > 1e-4;
      const range = 1 - NEAR;
      for (let i = 0; i < geometry.length; i += 3) {
        const j = i / 3 * 4;
        if (geometry[i + 2] < 0) {
          projected[j] = NaN;
          continue;
        }
        const z = NEAR + ((geometry[i + 2] - travel - NEAR) % range + range) % range;
        projected[j] = cx + geometry[i] / z * f;
        projected[j + 1] = cy + geometry[i + 1] / z * f;
        const z0 = Math.min(1.2, Math.max(NEAR, z + streak));
        projected[j + 2] = cx + geometry[i] / z0 * f;
        projected[j + 3] = cy + geometry[i + 1] / z0 * f;
      }
      ctx.lineCap = "round";
      drawStarfield(ctx, field, projected, 4, w, h, 1, moving);
      ctx.globalAlpha = 1;
    };
    settle.current = (travel) => {
      const range = 1 - NEAR;
      for (let i = 2; i < geometry.length; i += 3) {
        if (geometry[i] >= 0) geometry[i] = NEAR + ((geometry[i] - travel - NEAR) % range + range) % range;
      }
      draw.current(0);
    };
    void loadStarfield().then((catalogue) => {
      if (disposed || !catalogue) return;
      field = catalogue;
      geometry = new Float32Array(field.xyz.length);
      projected = new Float32Array(field.xyz.length / 3 * 4);
      prepare.current();
      draw.current(0);
    });
    resize();
    const ro = new ResizeObserver(([entry]) => {
      viewportWidth = entry.contentRect.width;
      viewportHeight = entry.contentRect.height;
      resize();
    });
    ro.observe(document.documentElement);
    return () => {
      disposed = true;
      prepare.current = () => {};
      draw.current = () => {};
      settle.current = () => {};
      ro.disconnect();
    };
  }, []);

  useEffect(() => {
    let lastProgress = 0;
    return subscribeFlight((sample) => {
      const backdrop = backdropRef.current;
      if (sample.progress === 0) {
        if (ref.current) {
          ref.current.style.transition = "none";
          ref.current.style.translate = "0px 0px";
        }
        prepare.current();
        lastProgress = 0;
      }
      if (backdrop) {
        backdrop.style.transition = "none";
        backdrop.style.opacity = String(0.55 * (1 - sample.camera.fade));
        backdrop.dataset.traveling = String(sample.progress < 1);
      }
      if (sample.progress === 1 && ref.current) ref.current.style.removeProperty("transition");
      if (sample.reduced) return;
      focus.current = { x: sample.pose.x + 24, y: sample.pose.y + 24 };
      const speed = 6 * sample.progress * (1 - sample.progress);
      const travel = sample.u * 0.8;
      draw.current(sample.direction * speed * (sample.progress - lastProgress) * 4, travel);
      lastProgress = sample.progress;
      if (sample.progress === 1) {
        if (backdrop) delete backdrop.dataset.traveling;
        settle.current(travel);
      }
    });
  }, []);

  useEffect(() => {
    if (!flightIsActive() && backdropRef.current) {
      backdropRef.current.style.removeProperty("opacity");
      backdropRef.current.style.removeProperty("transition");
    }
  }, [dim]);

  // Slow parallax on pointer move. Skipped under reduced motion.
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    if (!dim || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let raf = 0;
    const onMove = (e: PointerEvent) => {
      if (flightIsActive()) return;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const dx = (e.clientX / window.innerWidth - 0.5) * -16;
        const dy = (e.clientY / window.innerHeight - 0.5) * -16;
        cv.style.translate = `${dx}px ${dy}px`;
      });
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("pointermove", onMove);
    };
  }, [dim]);

  return (
    <div ref={backdropRef} className={s.backdrop} data-dim={dim} data-home={!dim} aria-hidden="true">
      <canvas ref={ref} className={s.canvas} />
      <div className={s.vignette} />
    </div>
  );
}
