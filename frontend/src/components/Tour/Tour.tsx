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
  for (const key of [step.target, step.fallback]) {
    if (!key) continue;
    for (const el of document.querySelectorAll<HTMLElement>(`[data-tour="${key}"]`)) {
      if (el.getBoundingClientRect().width > 0 && getComputedStyle(el).visibility !== "hidden") return el;
    }
  }
  return null;
}

function place(rect: Rect | null, hole: HTMLDivElement, card: HTMLDivElement, round?: boolean) {
  // Card placement: below the hole when there is room, otherwise anchored above it (no height needed).
  const pad = 8;
  const cardW = Math.min(340, window.innerWidth - 32);
  let pos: { left: number; top?: number; bottom?: number } = { left: 16, top: 16 };
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

  Object.assign(hole.style, rect ? {
    left: `${rect.left - pad}px`, top: `${rect.top - pad}px`,
    width: `${rect.width + pad * 2}px`, height: `${rect.height + pad * 2}px`,
    borderRadius: round ? "50%" : "",
  } : { left: "50%", top: "50%", width: "0px", height: "0px" });
  Object.assign(card.style, { left: `${pos.left}px`, top: pos.top === undefined ? "" : `${pos.top}px`,
    bottom: pos.bottom === undefined ? "" : `${pos.bottom}px`, width: `${cardW}px` });

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
    return () => {
      if (d?.open) d.close();
      back?.focus({ preventScroll: true });
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
        const r = el.getBoundingClientRect();
        const prev = measured.current;
        if (!prev || prev.left !== r.left || prev.top !== r.top || prev.width !== r.width || prev.height !== r.height) {
          measured.current = { left: r.left, top: r.top, width: r.width, height: r.height };
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
