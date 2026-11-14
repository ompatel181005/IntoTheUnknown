import { useEffect, useRef } from "react";
import { seeded } from "../../lib/sky";
import { tokenRgb } from "../../lib/stretch";
import s from "./SkyBackdrop.module.css";

interface Star {
  x: number;
  y: number;
  z: number;
  /** 0 = white, 1 = warm, 2 = blue-white. */
  tint: number;
}

const COUNT = 2600;
/** Share of stars packed into a Milky Way band across the field. */
const BAND_SHARE = 0.4;
const TRAVEL_MS = 1000;
const NEAR = 0.04;

/**
 * Decorative 3D starfield behind everything. It is not data: the stars are random and the science image
 * sits on an opaque dome above it. When `travelKey` changes the field flies forward (a target was picked)
 * or backward (`travelKey` became null: back to the whole sky), like moving through space.
 */
export function SkyBackdrop({ dim, travelKey }: { dim: boolean; travelKey: string | null }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const stars = useRef<Star[]>([]);
  const draw = useRef<(streak: number) => void>(() => {});
  const lastKey = useRef<string | null | undefined>(undefined);
  const anim = useRef(0);

  // Build the field and the painter once; repaint on resize.
  useEffect(() => {
    const cv = ref.current;
    const ctx = cv?.getContext("2d");
    if (!cv || !ctx) return;
    const rnd = seeded(20261115);
    const gauss = () => Math.sqrt(-2 * Math.log(rnd() || 1e-9)) * Math.cos(2 * Math.PI * rnd());
    stars.current = Array.from({ length: COUNT }, () => {
      const inBand = rnd() < BAND_SHARE;
      const x = rnd() * 2 - 1;
      const y = inBand ? 0.42 * x + gauss() * 0.09 : rnd() * 2 - 1;
      const t = rnd();
      return { x, y, z: NEAR + rnd() * (1 - NEAR), tint: t < 0.08 ? 1 : t < 0.16 ? 2 : 0 };
    });
    const palette = [tokenRgb("--star"), tokenRgb("--sun"), tokenRgb("--accent")];
    let w = 0;
    let h = 0;
    const resize = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      w = window.innerWidth + 48;
      h = window.innerHeight + 48;
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
      cv.style.width = `${w}px`;
      cv.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      draw.current(0);
    };
    // `streak` is how far (in z) each star moved this frame; it draws motion trails.
    draw.current = (streak: number) => {
      ctx.clearRect(0, 0, w, h);
      const cx = w / 2;
      const cy = h / 2;
      const f = Math.max(w, h) * 0.5;
      for (const st of stars.current) {
        const px = cx + (st.x / st.z) * f;
        const py = cy + (st.y / st.z) * f;
        if (px < -50 || py < -50 || px > w + 50 || py > h + 50) continue;
        const near = 1 - st.z;
        const a = 0.14 + near ** 2 * 0.86;
        const [r, g, b] = palette[st.tint];
        if (Math.abs(streak) > 1e-4) {
          const z0 = Math.min(1.2, Math.max(NEAR, st.z + streak));
          ctx.strokeStyle = `rgba(${r},${g},${b},${a})`;
          ctx.lineWidth = 0.4 + near * 1.6;
          ctx.beginPath();
          ctx.moveTo(cx + (st.x / z0) * f, cy + (st.y / z0) * f);
          ctx.lineTo(px, py);
          ctx.stroke();
        } else {
          ctx.fillStyle = `rgba(${r},${g},${b},${a})`;
          ctx.beginPath();
          ctx.arc(px, py, 0.3 + near ** 3 * 1.7, 0, Math.PI * 2);
          ctx.fill();
          if (near > 0.9) {
            // The nearest few get a soft halo.
            ctx.fillStyle = `rgba(${r},${g},${b},0.08)`;
            ctx.beginPath();
            ctx.arc(px, py, 5, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }
    };
    resize();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);

  // Fly when the target changes. Skipped on first render and under reduced motion.
  useEffect(() => {
    const prev = lastKey.current;
    lastKey.current = travelKey;
    if (prev === undefined || prev === travelKey) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const dir = travelKey === null ? -1 : 1;
    cancelAnimationFrame(anim.current);
    const start = performance.now();
    let last = start;
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / TRAVEL_MS);
      const speed = Math.sin(Math.PI * t) ** 2 * 1.6; // ease in and out, in z-units per second
      const dz = (speed * (now - last)) / 1000;
      last = now;
      for (const st of stars.current) {
        st.z -= dir * dz;
        if (st.z < NEAR) {
          st.z += 1 - NEAR;
          st.x = Math.random() * 2 - 1;
          st.y = Math.random() < BAND_SHARE ? 0.42 * st.x + (Math.random() - 0.5) * 0.25 : Math.random() * 2 - 1;
        } else if (st.z > 1) {
          st.z -= 1 - NEAR;
        }
      }
      draw.current(t < 1 ? dir * dz * 6 : 0);
      if (t < 1) anim.current = requestAnimationFrame(step);
    };
    anim.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(anim.current);
  }, [travelKey]);

  // Slow parallax on pointer move. Skipped under reduced motion.
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const cv = ref.current;
    if (!cv) return;
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
  }, []);

  return (
    <div className={s.backdrop} data-dim={dim} aria-hidden="true">
      <canvas ref={ref} className={s.canvas} />
      <div className={s.vignette} />
    </div>
  );
}
