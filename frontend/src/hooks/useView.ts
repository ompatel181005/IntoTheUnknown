import { useEffect, useState } from "react";
import type { LoadProgress, LoadedView, ViewQuery, ViewSource } from "../data/source";

export type ViewState =
  | { kind: "idle" }
  | { kind: "loading"; progress: LoadProgress | null }
  | { kind: "ready"; view: LoadedView }
  | { kind: "error"; code: string; message: string };

type Settled = { key: string } & ({ kind: "ready"; view: LoadedView } | { kind: "error"; code: string; message: string });

/** Load a view through a source. `attempt` changes on Retry and forces a fresh load. */
export function useView(source: ViewSource, query: ViewQuery | null, attempt: number): ViewState {
  const key = query ? `${JSON.stringify(query)}#${attempt}` : null;
  const [settled, setSettled] = useState<Settled | null>(null);
  const [progress, setProgress] = useState<{ key: string; p: LoadProgress } | null>(null);

  useEffect(() => {
    if (!query || !key) return;
    const ac = new AbortController();
    source
      .load(query, (p) => setProgress({ key, p }), ac.signal)
      .then(
        (view) => setSettled({ key, kind: "ready", view }),
        (e: unknown) => {
          const err = e as { name?: string; code?: string; message?: string };
          if (err.name === "AbortError") return;
          setSettled({
            key,
            kind: "error",
            code: err.code ?? "ERROR",
            message: err.message ?? "Could not load this view. Try again.",
          });
        },
      );
    return () => ac.abort();
    // `key` encodes query and attempt.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, key]);

  if (!query || !key) return { kind: "idle" };
  if (settled?.key === key) return settled;
  return { kind: "loading", progress: progress?.key === key ? progress.p : null };
}
