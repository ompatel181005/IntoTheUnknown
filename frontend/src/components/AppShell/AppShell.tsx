import { useLayoutEffect, useRef, type ReactNode } from "react";
import s from "./AppShell.module.css";

interface AppShellProps {
  idle: boolean;
  flying: boolean;
  /** Width reserved on the left of the stage (object card), in px. */
  stageLeft: number;
  /** Width reserved on the right of the stage (drawer or tool rail), in px. */
  stageRight: number;
  backdrop: ReactNode;
  /** Hide the playback bar (the mobile bottom sheet takes its place). */
  hideBottom: boolean;
  /** Extra height reserved at the bottom (mobile bottom sheet), in px. */
  bottomReserve: number;
  stage: ReactNode;
  top: ReactNode;
  /** Null hides the playback dock (home screen). */
  bottom: ReactNode | null;
  overlays: ReactNode;
}

/**
 * The stage fills the viewport. Top and bottom chrome float over it; their measured heights
 * become --chrome-top and --chrome-bottom so the sky image is never placed under glass.
 */
export function AppShell({ idle, flying, stageLeft, stageRight, hideBottom, bottomReserve, backdrop, stage, top, bottom, overlays }: AppShellProps) {
  const hasBottom = bottom !== null;
  const shellRef = useRef<HTMLDivElement>(null);
  const topRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const shell = shellRef.current;
    if (!shell) return;
    const measure = () => {
      const gutter = 16;
      const t = topRef.current?.getBoundingClientRect().height ?? 0;
      const b = hideBottom ? 0 : (bottomRef.current?.getBoundingClientRect().height ?? 0);
      shell.style.setProperty("--chrome-top", `${Math.round(t + gutter * 2)}px`);
      shell.style.setProperty("--chrome-bottom", `${Math.round(Math.max(b, bottomReserve) + gutter * 2)}px`);
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (topRef.current) ro.observe(topRef.current);
    if (bottomRef.current) ro.observe(bottomRef.current);
    return () => ro.disconnect();
  }, [hideBottom, bottomReserve, hasBottom]);

  return (
    <div
      ref={shellRef}
      className={s.shell}
      data-idle={idle}
      data-app-shell
      data-flying={flying}
      style={{ ["--stage-right" as string]: `${stageRight}px`, ["--stage-left" as string]: `${stageLeft}px` }}
    >
      {backdrop}
      <main className={s.stage}>{stage}</main>
      <div ref={topRef} className={`${s.top} ${s.chrome}`}>
        {top}
      </div>
      {bottom !== null && (
        <div ref={bottomRef} className={`${s.bottom} ${s.chrome} ${s.bottomIn} ${hideBottom ? s.hiddenOnSheet : ""}`}>
          {bottom}
        </div>
      )}
      {overlays}
    </div>
  );
}
