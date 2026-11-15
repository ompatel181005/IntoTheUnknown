import { useCallback, useEffect, useRef, useState } from "react";
import { pad2 } from "../../lib/format";
import type { ViewMode } from "../../lib/url";
import type { Epoch } from "../../types";
import { GlassButton, GlassPanel, Icon, Segmented } from "../glass";
import s from "./PlaybackBar.module.css";

interface PlaybackBarProps {
  epochs: Epoch[];
  index: number;
  sequence: number[];
  playing: boolean;
  canPlay: boolean;
  mode: ViewMode;
  status: string | null;
  /** A target is chosen but its passes are still loading. */
  loading: boolean;
  customizeOpen: boolean;
  onToggle: () => void;
  onPrev: () => void;
  onNext: () => void;
  onSeek: (i: number) => void;
  onMode: (m: ViewMode) => void;
  onCustomize: () => void;
  detailsOpen?: boolean;
  onDetails?: () => void;
}

const W = 720;
const H = 64;
const DEPTH = 26;
/** Point on the time arc for t in [0, 1]: ends high, middle low (NASA Eyes style). */
const arc = (t: number) => ({ x: 24 + t * (W - 48), y: 10 + DEPTH * (1 - (2 * t - 1) ** 2) });
const ARC_PATH = Array.from({ length: 41 }, (_, i) => {
  const p = arc(i / 40);
  return `${i ? "L" : "M"}${p.x.toFixed(1)},${p.y.toFixed(1)}`;
}).join("");

const LANDING_HINT_KEY = "spherex:landing-hint-seen";
const MODE_HINT_PREFIX = "spherex:mode-hint:";

const MODE_HINTS: Record<ViewMode, string> = {
  all: "Watch for anything that jumps in a straight line between passes",
  blink: "Flips between two passes; movers hop, variables flash",
  diff: "Subtracts the reference pass; a moving object leaves a silver and amber pair",
  inspect: "Opens spectra, brightness over time and file details",
};

function safeGetItem(key: string): string | null {
  try {
    return typeof window !== "undefined" && window.localStorage ? window.localStorage.getItem(key) : null;
  } catch {
    return null;
  }
}

function safeSetItem(key: string, val: string): void {
  try {
    if (typeof window !== "undefined" && window.localStorage) {
      window.localStorage.setItem(key, val);
    }
  } catch {
    // Ignore storage quota or security errors
  }
}

/** Time controls: transport and readout, then the passes laid out along an arc with a moving crescent knob. */
export function PlaybackBar(p: PlaybackBarProps) {
  const ready = p.epochs.length > 0;
  const multi = p.epochs.length > 1;
  const e = p.epochs[p.index];
  const n = ready ? p.epochs.length : 4;
  const tOf = (i: number) => (n === 1 ? 0.5 : i / (n - 1));
  const knob = ready ? arc(tOf(p.index)) : null;
  const stateText = p.loading ? "Loading" : !ready ? "No target" : !multi ? "One pass" : p.playing ? "Playing" : "Paused";

  const [activeHint, setActiveHint] = useState<{ id: string; text: string; fading: boolean } | null>(null);
  const hintTimerRef = useRef<number | null>(null);
  const fadeTimerRef = useRef<number | null>(null);
  const prevModeRef = useRef<ViewMode>(p.mode);
  const hasLandedRef = useRef<boolean>(false);

  const dismissHint = useCallback((id?: string) => {
    if (hintTimerRef.current) window.clearTimeout(hintTimerRef.current);
    if (fadeTimerRef.current) window.clearTimeout(fadeTimerRef.current);
    window.setTimeout(() => {
      setActiveHint((prev) => {
        if (!prev) return null;
        if (id && prev.id !== id) return prev;
        return { ...prev, fading: true };
      });
      fadeTimerRef.current = window.setTimeout(() => {
        setActiveHint(null);
      }, 400);
    }, 0);
  }, []);

  const triggerHint = useCallback((id: string, text: string, durationMs: number) => {
    if (hintTimerRef.current) window.clearTimeout(hintTimerRef.current);
    if (fadeTimerRef.current) window.clearTimeout(fadeTimerRef.current);

    window.setTimeout(() => {
      setActiveHint({ id, text, fading: false });

      hintTimerRef.current = window.setTimeout(() => {
        setActiveHint((prev) => (prev && prev.id === id ? { ...prev, fading: true } : prev));
        fadeTimerRef.current = window.setTimeout(() => {
          setActiveHint((prev) => (prev && prev.id === id ? null : prev));
        }, 400);
      }, durationMs);
    }, 0);
  }, []);

  // Landing hint: triggers once on first landing, dismisses on play or after 6s
  useEffect(() => {
    if (ready && !p.loading && !hasLandedRef.current) {
      hasLandedRef.current = true;
      if (!safeGetItem(LANDING_HINT_KEY)) {
        safeSetItem(LANDING_HINT_KEY, "1");
        triggerHint("landing", "Press Play and watch the centre star against the background", 6000);
      }
    }
  }, [ready, p.loading, triggerHint]);

  // When play begins, dismiss the landing hint immediately
  useEffect(() => {
    if (p.playing && activeHint?.id === "landing") {
      dismissHint("landing");
    }
  }, [p.playing, activeHint?.id, dismissHint]);

  // Trigger mode hint for new mode selection if unvisited
  const handleMode = useCallback(
    (nextMode: ViewMode) => {
      p.onMode(nextMode);
      const key = `${MODE_HINT_PREFIX}${nextMode}`;
      if (!safeGetItem(key)) {
        safeSetItem(key, "1");
        triggerHint(`mode-${nextMode}`, MODE_HINTS[nextMode], 4000);
      }
    },
    [p, triggerHint],
  );

  // Also catch mode switches from keyboard shortcuts (B, D, I)
  useEffect(() => {
    if (prevModeRef.current !== p.mode) {
      const nextMode = p.mode;
      prevModeRef.current = nextMode;
      const key = `${MODE_HINT_PREFIX}${nextMode}`;
      if (!safeGetItem(key)) {
        safeSetItem(key, "1");
        triggerHint(`mode-${nextMode}`, MODE_HINTS[nextMode], 4000);
      }
    }
  }, [p.mode, triggerHint]);

  // Clean up timers on unmount
  useEffect(() => {
    return () => {
      if (hintTimerRef.current) window.clearTimeout(hintTimerRef.current);
      if (fadeTimerRef.current) window.clearTimeout(fadeTimerRef.current);
    };
  }, []);

  return (
    <div className={s.dock} data-tour="time">
      {activeHint && (
        <div
          role="status"
          aria-live="polite"
          className={s.hintBanner}
          data-fading={activeHint.fading}
        >
          {activeHint.text}
        </div>
      )}
      <ModeSwitch mode={p.mode} multi={multi} ready={ready} loading={p.loading} onMode={handleMode} />
      <div className={s.clock}>
        <div className={s.row}>
          <div className={s.transport}>
            <GlassButton variant="ghost" icon="prev" label="Previous pass" onClick={p.onPrev} disabled={!multi} title={titleFor(ready, multi)} />
            <GlassButton
              variant="primary"
              className={s.play}
              onClick={p.onToggle}
              disabled={!p.canPlay}
              aria-label={p.playing ? "Pause" : "Play"}
              title={!p.canPlay ? (ready ? "Needs at least two passes" : "Pick a target") : "Play or pause (Space)"}
              data-tour="play"
            >
              <Icon name={p.playing ? "pause" : "play"} size={20} />
            </GlassButton>
            <GlassButton variant="ghost" icon="next" label="Next pass" onClick={p.onNext} disabled={!multi} title={titleFor(ready, multi)} />
          </div>
          <span className={`display ${s.date}`}>{e ? e.label : "----"}</span>
          <span className={s.state} data-playing={p.playing} aria-live="polite">
            <span className={s.stateDot} aria-hidden="true" />
            {stateText}
          </span>
          <span className={`mono ${s.epoch}`}>
            PASS {e ? pad2(e.i + 1) : "--"} / {ready ? pad2(p.epochs.length) : "--"}
          </span>
          <div className={s.actions}>
            {p.onDetails && (
              <GlassButton
                variant="ghost"
                className={s.details}
                icon="info"
                label="Details"
                aria-label="Details"
                aria-expanded={p.detailsOpen}
                aria-controls="drawer"
                disabled={p.loading}
                onClick={p.onDetails}
                data-tour="details-btn"
              />
            )}
            <GlassButton
              variant="ghost"
              className={s.customize}
              icon="sliders"
              label="Customize"
              aria-expanded={p.customizeOpen}
              aria-controls="customize"
              onClick={p.onCustomize}
              data-tour="customize-btn"
            />
          </div>
        </div>

        <nav className={s.arcWrap} aria-label="Passes">
          <svg viewBox={`0 0 ${W} ${H}`} className={s.arc} aria-hidden="true" preserveAspectRatio="none">
            <path d={ARC_PATH} className={s.arcLine} />
          </svg>
          <ol className={s.ticks}>
            {Array.from({ length: n }, (_, i) => {
              const ep = p.epochs[i];
              const pt = arc(tOf(i));
              const active = ready && i === p.index;
              const placeholder = !ep;
              return (
                <li key={i} className={s.tickItem} style={{ left: `${(pt.x / W) * 100}%`, top: `${(pt.y / H) * 100}%` }}>
                  <button
                    type="button"
                    className={s.tick}
                    aria-current={active}
                    data-out={ready && !placeholder && !p.sequence.includes(i)}
                    disabled={placeholder}
                    aria-label={ep ? `Pass ${i + 1}, ${ep.label}` : `Pass ${i + 1}`}
                    title={placeholder ? (ready ? undefined : "Pick a target") : undefined}
                    onClick={() => p.onSeek(i)}
                  >
                    <span className={s.dot} />
                    {ep && <span className={`${s.tickDate} mono`}>{ep.label}</span>}
                  </button>
                </li>
              );
            })}
          </ol>
          {knob && (
            <span className={s.knob} style={{ left: `${(knob.x / W) * 100}%`, top: `${(knob.y / H) * 100}%` }} aria-hidden="true">
              <TargetReticle />
            </span>
          )}
        </nav>
      </div>
    </div>
  );
}

function titleFor(ready: boolean, multi: boolean) {
  if (!ready) return "Pick a target";
  if (!multi) return "Needs at least two passes";
  return undefined;
}

function TargetReticle() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
      <circle cx="10" cy="10" r="8" fill="var(--space-1)" stroke="var(--accent)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
      <circle cx="10" cy="10" r="2.5" fill="var(--accent)" />
    </svg>
  );
}

function ModeSwitch({
  mode,
  multi,
  ready,
  loading,
  onMode,
}: {
  mode: ViewMode;
  multi: boolean;
  ready: boolean;
  loading: boolean;
  onMode: (m: ViewMode) => void;
}) {
  const why = ready ? "Needs at least two passes" : "Pick a target";
  return (
    <GlassPanel pill className={s.modes} data-tour="modes">
      <Segmented
        label="View mode"
        value={mode}
        onChange={onMode}
        className={s.segmented}
        options={[
          {
            value: "all",
            label: (
              <span className={s.modeLabel}>
                <span>Play all</span>
                <span className={s.modeTip} role="tooltip">
                  {MODE_HINTS.all}
                </span>
              </span>
            ),
            disabled: !ready,
            title: ready ? MODE_HINTS.all : why,
          },
          ...(loading || multi
            ? [
                {
                  value: "blink" as const,
                  label: (
                    <span className={s.modeLabel}>
                      <span>Blink</span>
                      <span className={s.modeTip} role="tooltip">
                        {MODE_HINTS.blink}
                      </span>
                    </span>
                  ),
                  disabled: !multi,
                  title: multi ? MODE_HINTS.blink : why,
                },
                {
                  value: "diff" as const,
                  label: (
                    <span className={s.modeLabel}>
                      <span>Difference</span>
                      <span className={s.modeTip} role="tooltip">
                        {MODE_HINTS.diff}
                      </span>
                    </span>
                  ),
                  disabled: !multi,
                  title: multi ? MODE_HINTS.diff : why,
                },
              ]
            : []),
          {
            value: "inspect",
            label: (
              <span className={s.modeLabel}>
                <span>Investigate</span>
                <span className={s.modeTip} role="tooltip">
                  {MODE_HINTS.inspect}
                </span>
              </span>
            ),
            disabled: !ready,
            title: ready ? MODE_HINTS.inspect : why,
          },
        ]}
      />
    </GlassPanel>
  );
}
