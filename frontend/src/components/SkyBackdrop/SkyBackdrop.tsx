import { useEffect, useRef } from "react";
import { flightIsActive, getHomeCamera, markFlight, subscribeFlight } from "../../lib/flight";
import { loadStarfield, mountStarfield } from "../../lib/starfield";
import s from "./SkyBackdrop.module.css";

/**
 * BSC5 catalogue directions, visual magnitudes and B-V colours behind the science dome.
 * The warp is decorative: its synthetic travel depths are not stellar distances.
 * The shared flight clock supplies position, direction and speed.
 */
export function SkyBackdrop({ dim }: { dim: boolean }) {
  const backdropRef = useRef<HTMLDivElement>(null);
  const ref = useRef<HTMLDivElement>(null);
  const prepare = useRef<() => void>(() => {});
  const draw = useRef<(streak: number, travel?: number) => void>(() => {});
  const settle = useRef<(travel: number) => void>(() => {});
  /** Current vanishing point in canvas pixels (NaN = canvas centre). */
  const focus = useRef({ x: NaN, y: NaN });

  // Build the field and the painter once; repaint on resize.
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const starfield = mountStarfield(cv);
    let camera = getHomeCamera();
    let needsPrepare = true;
    let settledTravel = 0;
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
      starfield.paint({ width: w, height: h, dpr });
      cv.style.width = `${w}px`;
      cv.style.height = `${h}px`;
      draw.current(0);
    };
    prepare.current = () => {
      camera = getHomeCamera();
      needsPrepare = true;
      settledTravel = 0;
    };
    draw.current = (streak: number, travel = settledTravel) => {
      starfield.paint({
        ...camera,
        x: Number.isFinite(focus.current.x) ? focus.current.x : w / 2,
        y: Number.isFinite(focus.current.y) ? focus.current.y : h / 2,
        focal: Math.max(w, h) * 0.5,
        fade: 1, streak, travel, prepare: needsPrepare,
      });
      needsPrepare = false;
    };
    settle.current = (travel) => {
      settledTravel = travel;
      draw.current(0);
    };
    void loadStarfield().then((field) => {
      if (disposed || !field) return;
      starfield.paint({ field });
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
      starfield.dispose();
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
      <div ref={ref} className={s.canvas} />
      <div className={s.vignette} />
    </div>
  );
}
