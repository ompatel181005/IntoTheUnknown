import { useCallback, useEffect, useState } from "react";
import type { ViewMode } from "../lib/url";

/** Epoch order for a mode. Blink alternates the reference and the last pass; difference skips the reference. */
export function sequenceFor(mode: ViewMode, count: number, ref = 0): number[] {
  if (count <= 0) return [];
  const r = Math.min(Math.max(ref, 0), count - 1);
  if (mode === "blink") return count > 1 ? [r, r === count - 1 ? 0 : count - 1] : [0];
  if (mode === "diff") return count > 1 ? Array.from({ length: count }, (_, i) => i).filter((i) => i !== r) : [0];
  return Array.from({ length: count }, (_, i) => i);
}

interface State {
  key: string;
  index: number;
  playing: boolean;
  loops: number;
  played: boolean;
}

/**
 * Flipbook clock. `resetKey` identifies the loaded view; a new key starts again at `initial`.
 * `loops` counts completed passes through the sequence across the session (the step guide uses it).
 */
export function usePlayback(resetKey: string, count: number, mode: ViewMode, speed: number, initial: number, ref = 0) {
  const seq = sequenceFor(mode, count, ref);
  const fresh = (): State => ({
    key: resetKey,
    index: Math.min(Math.max(initial, 0), Math.max(count - 1, 0)),
    playing: false,
    loops: 0,
    played: false,
  });
  const [raw, setRaw] = useState<State>(fresh);
  // A new view resets position but keeps session progress (played, loops) for the step guide.
  const carry = (prev: State): State => ({ ...fresh(), played: prev.played, loops: prev.loops });
  const st = raw.key === resetKey ? raw : carry(raw);
  const index = seq.includes(st.index) ? st.index : (seq[0] ?? 0);
  const canPlay = seq.length > 1;

  const update = useCallback(
    (fn: (s: State) => State) =>
      setRaw((prev) => {
        const base = prev.key === resetKey ? prev : carry(prev);
        return fn(base);
      }),
    // fresh() and carry() only read resetKey, initial and count.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [resetKey, initial, count],
  );

  const advance = useCallback(
    (dir: 1 | -1, fromTimer: boolean) =>
      update((s) => {
        const cur = seq.indexOf(s.index);
        const pos = cur < 0 ? 0 : cur;
        const next = (pos + dir + seq.length) % seq.length;
        const wrapped = fromTimer && dir === 1 && next === 0;
        return { ...s, index: seq[next] ?? 0, loops: s.loops + (wrapped ? 1 : 0), playing: fromTimer ? s.playing : false };
      }),
    // seq is derived from mode and count.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [update, mode, count, ref],
  );

  useEffect(() => {
    if (!st.playing || !canPlay) return;
    const t = window.setInterval(() => advance(1, true), 1000 / speed);
    return () => window.clearInterval(t);
  }, [st.playing, canPlay, speed, advance]);

  return {
    index,
    playing: st.playing && canPlay,
    canPlay,
    loops: st.loops,
    played: st.played,
    sequence: seq,
    play: () => canPlay && update((s) => ({ ...s, playing: true, played: true })),
    pause: () => update((s) => ({ ...s, playing: false })),
    toggle: () => canPlay && update((s) => ({ ...s, playing: !s.playing, played: true })),
    next: () => advance(1, false),
    prev: () => advance(-1, false),
    seek: (i: number) => update((s) => ({ ...s, index: i, playing: false })),
  };
}
