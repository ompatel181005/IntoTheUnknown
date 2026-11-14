import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { GlassButton } from "../glass";
import { TOUR, type TourStep } from "./steps";
import s from "./Tour.module.css";

interface TourProps {
  /** Make the app show what a step needs (load a target, open a panel). */
  prepare: (needs: TourStep["needs"]) => void;
  onClose: () => void;
}

type Rect = { left: number; top: number; width: number; height: number };

function find(step: TourStep): HTMLElement | null {
  for (const key of [step.target, step.fallback]) {
    if (!key) continue;
    const el = document.querySelector<HTMLElement>(`[data-tour="${key}"]`);
    if (el && el.getBoundingClientRect().width > 0) return el;
  }
  return null;
}

/** Spotlight tour: dims the screen, cuts a hole around one control, and explains it. */
export function Tour({ prepare, onClose }: TourProps) {
  const [i, setI] = useState(0);
  const [rect, setRect] = useState<Rect | null>(null);
  const [dir, setDir] = useState<1 | -1>(1);
  const nextRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const step = TOUR[i];

  // A real modal: the page behind is inert, focus stays in the tour and returns where it was on close.
  useEffect(() => {
    const d = dialogRef.current;
    const back = document.activeElement as HTMLElement | null;
    if (d && !d.open) d.showModal();
    return () => {
      if (d?.open) d.close();
      back?.focus({ preventScroll: true });
    };
  }, []);

  // Prepare the step, then follow its element every frame (it may load, remount or slide in).
  // Steps whose element never shows up are skipped: after ~8 s when data must load, ~1.5 s otherwise.
  useEffect(() => {
    prepare(step.needs);
    const started = performance.now();
    const patience = step.needs === "view" || step.needs === "drawer" ? 8000 : 1500;
    let raf = 0;
    let seen = false;
    const tick = () => {
      const el = find(step);
      if (el) {
        seen = true;
        const r = el.getBoundingClientRect();
        setRect((prev) =>
          prev && prev.left === r.left && prev.top === r.top && prev.width === r.width && prev.height === r.height
            ? prev
            : { left: r.left, top: r.top, width: r.width, height: r.height },
        );
      } else if (!seen && performance.now() - started > patience) {
        const n = i + dir;
        if (n >= TOUR.length || n < 0) onClose();
        else setI(n);
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // Re-run per step only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [i]);

  useLayoutEffect(() => {
    nextRef.current?.focus({ preventScroll: true });
  }, [i]);

  const go = (d: 1 | -1) => {
    setDir(d);
    if (i + d >= TOUR.length) return onClose();
    if (i + d < 0) return;
    setRect(null);
    setI(i + d);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowRight") go(1);
    else if (e.key === "ArrowLeft") go(-1);
    e.stopPropagation();
  };

  // Card placement: below the hole when there is room, otherwise anchored above it (no height needed).
  const pad = 8;
  const cardW = Math.min(340, window.innerWidth - 32);
  let pos: React.CSSProperties = { left: 16, top: 16 };
  if (rect) {
    const left = Math.max(16, Math.min(window.innerWidth - cardW - 16, rect.left + rect.width / 2 - cardW / 2));
    const below = rect.top + rect.height + pad + 14;
    const top = Math.max(16, Math.min(rect.top, window.innerHeight - 280));
    if (window.innerHeight - below > 240) pos = { left, top: below };
    else if (rect.top - pad - 14 > 240) pos = { left, bottom: window.innerHeight - (rect.top - pad - 14) };
    else if (rect.left - pad - 24 > cardW) pos = { left: rect.left - pad - 24 - cardW, top };
    else if (window.innerWidth - (rect.left + rect.width + pad + 24) > cardW) pos = { left: rect.left + rect.width + pad + 24, top };
    else pos = { left, bottom: 16 };
  }

  return (
    <dialog
      ref={dialogRef}
      className={s.tour}
      aria-labelledby="tour-title"
      onKeyDown={onKey}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <div
        className={s.hole}
        style={
          rect
            ? {
                left: rect.left - pad,
                top: rect.top - pad,
                width: rect.width + pad * 2,
                height: rect.height + pad * 2,
                borderRadius: step.round ? "50%" : undefined,
              }
            : { left: "50%", top: "50%", width: 0, height: 0 }
        }
      />
      <div className={s.card} style={{ ...pos, width: cardW }}>
        <p className={`micro ${s.count}`}>
          Tour · {i + 1} / {TOUR.length}
        </p>
        <h2 id="tour-title" className={s.title}>
          {step.title}
        </h2>
        <p className={s.text}>{step.text}</p>
        <div className={s.actions}>
          <button type="button" className={s.skip} onClick={onClose}>
            Skip tour
          </button>
          <span className={s.spacer} />
          <GlassButton onClick={() => go(-1)} disabled={i === 0} title={i === 0 ? "This is the first step" : undefined}>
            Back
          </GlassButton>
          <button ref={nextRef} type="button" className={s.next} onClick={() => go(1)}>
            {i === TOUR.length - 1 ? "Done" : "Next"}
          </button>
        </div>
      </div>
    </dialog>
  );
}
