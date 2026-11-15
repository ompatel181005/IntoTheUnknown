import { useEffect, useLayoutEffect, useRef } from "react";
import { flightFocus, getHomeCamera, markFlight } from "../../lib/flight";
import { loadStarfield, type Starfield } from "../../lib/starfield";
import s from "./SkyBackdrop.module.css";

const TRAVEL_MS = 1000;
const NEAR = 0.04;

/**
 * BSC5 catalogue directions, visual magnitudes and B-V colours behind the science dome.
 * The warp is decorative: its synthetic travel depths are not stellar distances.
 * `travelKey` starts forward or reverse travel without blocking the first paint.
 */
export function SkyBackdrop({ dim, travelKey }: { dim: boolean; travelKey: string | null }) {
  const backdropRef = useRef<HTMLDivElement>(null);
  const ref = useRef<HTMLCanvasElement>(null);
  const prepare = useRef<() => void>(() => {});
  const draw = useRef<(streak: number, travel?: number) => void>(() => {});
  const settle = useRef<(travel: number) => void>(() => {});
  const lastKey = useRef<string | null | undefined>(undefined);
  const anim = useRef(0);
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
      for (const bucket of field.buckets) {
        ctx.beginPath();
        const r = bucket.radius;
        for (let i = bucket.start * 4; i < bucket.end * 4; i += 4) {
          const x = projected[i], y = projected[i + 1];
          if (!Number.isFinite(x) || x < -50 || y < -50 || x > w + 50 || y > h + 50) continue;
          if (moving) {
            ctx.moveTo(projected[i + 2], projected[i + 3]);
            ctx.lineTo(x, y);
          } else {
            ctx.moveTo(x + r, y);
            ctx.arc(x, y, r, 0, Math.PI * 2);
          }
        }
        ctx.globalAlpha = bucket.alpha;
        if (moving) {
          ctx.strokeStyle = bucket.color;
          ctx.lineWidth = bucket.radius * 2;
          ctx.stroke();
        } else {
          ctx.fillStyle = bucket.color;
          ctx.fill();
          if (bucket.alpha > 0.6) {
            ctx.beginPath();
            for (let i = bucket.start * 4; i < bucket.end * 4; i += 4) {
              const x = projected[i], y = projected[i + 1];
              if (!Number.isFinite(x) || x < -8 || y < -8 || x > w + 8 || y > h + 8) continue;
              ctx.moveTo(x + r * 4, y);
              ctx.arc(x, y, r * 4, 0, Math.PI * 2);
            }
            ctx.globalAlpha = bucket.alpha * 0.08;
            ctx.fill();
          }
        }
      }
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

  // Fly when the target changes. Skipped on first render and under reduced motion.
  useLayoutEffect(() => {
    const prev = lastKey.current;
    lastKey.current = travelKey;
    if (prev === undefined || prev === travelKey) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const dir = travelKey === null ? -1 : 1;
    if (dir > 0) prepare.current();
    const backdrop = backdropRef.current;
    cancelAnimationFrame(anim.current);
    if (backdrop) backdrop.dataset.traveling = "true";
    const start = performance.now();
    let last = start;
    let travel = 0;
    const PAD = 24; // the canvas overhangs the viewport by 24 px on each side
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / TRAVEL_MS);
      // Ease the vanishing point toward the star or dome the camera is flying at.
      if (Number.isFinite(flightFocus.tx)) {
        const fx = focus.current;
        const tx = flightFocus.tx + PAD;
        const ty = flightFocus.ty + PAD;
        if (!Number.isFinite(fx.x)) {
          fx.x = tx;
          fx.y = ty;
        } else {
          const k = Math.min(1, ((now - last) / 1000) * 10);
          fx.x += (tx - fx.x) * k;
          fx.y += (ty - fx.y) * k;
        }
      }
      const wave = Math.sin(Math.PI * t);
      const speed = wave * wave * 1.6; // ease in and out, in z-units per second
      const dz = (speed * (now - last)) / 1000;
      last = now;
      travel += dir * dz;
      if (t < 1) {
        draw.current(dir * dz * 6, travel);
        anim.current = requestAnimationFrame(step);
      } else {
        if (backdrop) delete backdrop.dataset.traveling;
        settle.current(travel);
      }
    };
    anim.current = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(anim.current);
      if (backdrop) delete backdrop.dataset.traveling;
    };
  }, [travelKey]);

  // Slow parallax on pointer move. Skipped under reduced motion.
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    if (!dim || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let raf = 0;
    const onMove = (e: PointerEvent) => {
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
