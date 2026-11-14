import { useEffect, useState } from "react";

export type AsyncState<T> =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; data: T }
  | { kind: "error"; message: string };

/** Run `fn` whenever `key` changes (null = idle). Results from stale keys are dropped. */
export function useAsync<T>(key: string | null, fn: (signal: AbortSignal) => Promise<T>): AsyncState<T> {
  const [settled, setSettled] = useState<{ key: string; state: AsyncState<T> } | null>(null);

  useEffect(() => {
    if (!key) return;
    const ac = new AbortController();
    fn(ac.signal).then(
      (data) => setSettled({ key, state: { kind: "ready", data } }),
      (e: { name?: string; message?: string }) => {
        if (e.name !== "AbortError") setSettled({ key, state: { kind: "error", message: e.message ?? "Request failed." } });
      },
    );
    return () => ac.abort();
    // `key` identifies the request; `fn` is recreated every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  if (!key) return { kind: "idle" };
  return settled?.key === key ? settled.state : { kind: "loading" };
}
