import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { GlassButton } from "../glass";
import { subscribeFlight } from "../../lib/flight";
import { TOUR, type TourStep } from "./steps";
import s from "./Tour.module.css";

interface TourProps {
  /** Make the app show what a step needs (load a target, open a panel). */
  prepare: (needs: TourStep["needs"]) => void;
  onClose: () => void;
}

type Rect = { left: number; top: number; width: number; height: number };

function find(step: TourStep): HTMLElement | null {
  for (const key of [step.target, ...(Array.isArray(step.fallback) ? step.fallback : [step.fallback])]) {
    if (!key) continue;
    for (const el of document.querySelectorAll<HTMLElement>(`[data-tour="${key}"]`)) {
      if (el.getBoundingClientRect().width > 0 && getComputedStyle(el).visibility !== "hidden") return el;
    }
  }
  return null;
}

function place(rect: Rect | null, hole: HTMLDivElement, card: HTMLDivElement, round?: boolean) {
  const pad = 8;
  const margin = 16;
  const gap = 14;
  const cardW = Math.min(340, window.innerWidth - 32);
  card.style.width = `${cardW}px`;
  const cardH = card.offsetHeight;
  let pos = { left: margin, top: margin };
  if (rect) {
    const centeredLeft = Math.max(margin, Math.min(window.innerWidth - cardW - margin, rect.left + rect.width / 2 - cardW / 2));
    const centeredTop = Math.max(margin, Math.min(window.innerHeight - cardH - margin, rect.top + rect.height / 2 - cardH / 2));
    const below = rect.top + rect.height + pad + gap;
    const above = rect.top - pad - gap - cardH;
    const left = rect.left - pad - gap - cardW;
    const right = rect.left + rect.width + pad + gap;
    if (below + cardH <= window.innerHeight - margin) pos = { left: centeredLeft, top: below };
    else if (above >= margin) pos = { left: centeredLeft, top: above };
    else if (right + cardW <= window.innerWidth - margin) pos = { left: right, top: centeredTop };
    else if (left >= margin) pos = { left, top: centeredTop };
    else pos = { left: centeredLeft, top: window.innerHeight - cardH - margin };
  }

  const holeLeft = rect ? Math.max(0, rect.left - pad) : window.innerWidth / 2;
  const holeTop = rect ? Math.max(0, rect.top - pad) : window.innerHeight / 2;
  Object.assign(hole.style, {
    left: `${holeLeft}px`,
    top: `${holeTop}px`,
    width: `${rect ? Math.min(window.innerWidth, rect.left + rect.width + pad) - holeLeft : 0}px`,
    height: `${rect ? Math.min(window.innerHeight, rect.top + rect.height + pad) - holeTop : 0}px`,
    borderRadius: round ? "50%" : "",
  });
  Object.assign(card.style, { left: `${pos.left}px`, top: `${pos.top}px`, bottom: "" });
}

/** Spotlight tour: dims the screen, cuts a hole around one control, and explains it. */
export function Tour({ prepare, onClose }: TourProps) {
  const [i, setI] = useState(0);
  const dir = useRef<1 | -1>(1);
  const holeRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const nextRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const measured = useRef<Rect | null>(null);
  const prepared = useRef<{ needs: TourStep["needs"] } | null>(null);
  const step = TOUR[i];

  // A real modal: the page behind is inert, focus stays in the tour and returns where it was on close.
  useEffect(() => {
    const d = dialogRef.current;
    const back = document.activeElement as HTMLElement | null;
    if (d && !d.open) d.showModal();
    nextRef.current?.focus({ preventScroll: true });
    return () => {
      if (d?.open) d.close();
      const visibleGuide = [...document.querySelectorAll<HTMLElement>('[data-tour^="guide-"]')]
        .find((el) => el.getBoundingClientRect().width > 0);
      const destination = back?.isConnected && back !== document.body ? back : visibleGuide;
      destination?.focus({ preventScroll: true });
    };
  }, []);

  // Follow layout changes and moving ancestors, without polling a settled page every frame.
  // Steps whose element never shows up are skipped: after ~8 s when data must load, ~1.5 s otherwise.
  useEffect(() => {
    measured.current = null;
    if (holeRef.current && cardRef.current) place(null, holeRef.current, cardRef.current);
    if (!prepared.current || prepared.current.needs !== step.needs) {
      prepared.current = { needs: step.needs };
      prepare(step.needs);
    }
    const started = performance.now();
    const patience = step.needs === "view" || step.needs === "drawer" ? 8000 : 1500;
    let raf = 0;
    let seen = false;
    let element: HTMLElement | null = null;
    let disposed = false;
    const resize = new ResizeObserver(() => schedule());
    const schedule = () => {
      if (!disposed && !raf) raf = requestAnimationFrame(tick);
    };
    const tick = () => {
      raf = 0;
      const el = element?.isConnected ? element : find(step);
      if (el) {
        if (el !== element) { resize.disconnect(); resize.observe(el); element = el; }
        seen = true;
        const raw = el.getBoundingClientRect();
        let targetRect: Rect;
        if (step.spotlightCenter) {
          const size = Math.min(84, Math.max(52, Math.round(raw.width * 0.16)));
          const cx = raw.left + raw.width / 2;
          const cy = raw.top + raw.height / 2;
          targetRect = { left: cx - size / 2, top: cy - size / 2, width: size, height: size };
        } else {
          targetRect = { left: raw.left, top: raw.top, width: raw.width, height: raw.height };
        }
        const prev = measured.current;
        if (
          !prev ||
          prev.left !== targetRect.left ||
          prev.top !== targetRect.top ||
          prev.width !== targetRect.width ||
          prev.height !== targetRect.height
        ) {
          measured.current = targetRect;
          if (holeRef.current && cardRef.current) place(measured.current, holeRef.current, cardRef.current, step.round);
        }
        for (let node: HTMLElement | null = el; node; node = node.parentElement) {
          if (node.getAnimations().some((animation) => animation.playState === "running")) { schedule(); break; }
        }
      } else if (!seen && performance.now() - started > patience) {
        const n = i + dir.current;
        if (n >= TOUR.length || n < 0) onClose();
        else setI(n);
        return;
      }
    };
    const mutations = new MutationObserver((records) => {
      if (!records.some((record) => [...record.addedNodes, ...record.removedNodes].some((node) => node.nodeType === Node.ELEMENT_NODE))) return;
      element = null;
      schedule();
    });
    mutations.observe(document.querySelector("[data-app-shell]")!, { childList: true, subtree: true });
    const timer = window.setInterval(() => { if (!seen) schedule(); }, 100);
    const viewportChange = () => { measured.current = null; schedule(); };
    window.addEventListener("resize", viewportChange);
    window.addEventListener("scroll", schedule, true);
    document.addEventListener("transitionrun", schedule, true);
    document.addEventListener("animationstart", schedule, true);
    const unsubscribe = subscribeFlight(schedule);
    schedule();
    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      clearInterval(timer);
      resize.disconnect();
      mutations.disconnect();
      unsubscribe();
      window.removeEventListener("resize", viewportChange);
      window.removeEventListener("scroll", schedule, true);
      document.removeEventListener("transitionrun", schedule, true);
      document.removeEventListener("animationstart", schedule, true);
    };
    // Re-run per step only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [i]);

  useLayoutEffect(() => {
    nextRef.current?.focus({ preventScroll: true });
  }, [i]);

  const go = (d: 1 | -1) => {
    dir.current = d;
    if (i + d >= TOUR.length) return onClose();
    if (i + d < 0) return;
    if (holeRef.current && cardRef.current) place(null, holeRef.current, cardRef.current);
    measured.current = null;
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
      <div ref={holeRef} className={s.hole} />
      <div ref={cardRef} className={s.card}>
        <p className={`micro ${s.count}`}>
          Tour · {i + 1} / {TOUR.length}
        </p>
        <h2 id="tour-title" className={s.title}>
          {step.title}
        </h2>
        <p className={s.text}>{step.text}</p>
        <div className={s.actions}>
          <button type="button" className={s.skip} onClick={onClose}>
            Skip
          </button>
          <span className={s.spacer} />
          <GlassButton onClick={() => go(-1)} disabled={i === 0} title={i === 0 ? "First step" : undefined}>
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
