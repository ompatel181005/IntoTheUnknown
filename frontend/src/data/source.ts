import { ApiRequestError, createView, fetchAsset, getViewStatus } from "../api";
import { findPreset } from "../lib/targets";
import type { Manifest, ViewRequest, ViewStage } from "../types";

export interface LoadedView {
  viewId: string;
  manifest: Manifest;
  images: Float32Array[];
  masks: (Uint8Array | null)[];
  /** True when served from a cache layer (golden snapshot or an already-rendered view). */
  fromCache: boolean;
  /** Set by non-production sources so the UI can label the data honestly. */
  label?: string;
}

export interface LoadProgress {
  stage: ViewStage;
  done?: number;
  total?: number;
}

export interface ViewQuery extends ViewRequest {
  presetId: string | null;
}

/** Where views come from. Production uses apiSource; the dev page swaps in a fixture. */
export interface ViewSource {
  load(q: ViewQuery, onProgress: (p: LoadProgress) => void, signal: AbortSignal): Promise<LoadedView>;
}

const POLL_MS = 1500;

function wait(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new DOMException("aborted", "AbortError"));
    });
  });
}

async function loadArrays(m: Manifest, base: string, signal: AbortSignal) {
  const images = await Promise.all(
    m.epochs.map(async (e) => new Float32Array(await (await fetchAsset(base + e.image, signal)).arrayBuffer())),
  );
  const masks = await Promise.all(
    m.epochs.map(async (e) => {
      if (!e.mask) return null;
      try {
        return new Uint8Array(await (await fetchAsset(base + e.mask, signal)).arrayBuffer());
      } catch {
        return null; // A missing mask only disables the flag overlay.
      }
    }),
  );
  return { images, masks };
}

const dirOf = (url: string) => url.slice(0, url.lastIndexOf("/") + 1);

/** docs/PLAN.md 4.4: presets in their default view load from /golden first, which needs no backend. */
async function tryGolden(q: ViewQuery, signal: AbortSignal): Promise<LoadedView | null> {
  const p = findPreset(q.presetId);
  if (!p || p.fov !== q.fov_arcmin || p.band !== q.band || q.source === "live") return null;
  const base = `/golden/${p.id}/`;
  let res: Response;
  try {
    res = await fetch(`${base}manifest.json`, { signal });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    return null;
  }
  if (!res.ok || !(res.headers.get("content-type") ?? "").includes("json")) return null;
  const manifest = (await res.json()) as Manifest;
  const arrays = await loadArrays(manifest, base, signal);
  return { viewId: manifest.render_key, manifest, ...arrays, fromCache: true };
}

export const apiSource: ViewSource = {
  async load(q, onProgress, signal) {
    const golden = await tryGolden(q, signal);
    if (golden) return golden;

    onProgress({ stage: "queued" });
    const { presetId: _presetId, ...body } = q;
    void _presetId;
    const created = await createView(body, signal);
    let manifestUrl = created.manifest_url;
    const fromCache = created.status === "ready";
    while (!manifestUrl) {
      if (!created.status_url) throw new ApiRequestError("BAD_RESPONSE", "Could not track progress. Try again.");
      await wait(POLL_MS, signal);
      const s = await getViewStatus(created.status_url, signal);
      if (s.status === "error") throw new ApiRequestError(s.error?.code ?? "ERROR", s.error?.message ?? "Could not build this view. Try again.");
      onProgress({ stage: s.status, done: s.progress?.done, total: s.progress?.total });
      if (s.status === "ready") manifestUrl = s.manifest_url;
    }
    const manifest = (await (await fetchAsset(manifestUrl, signal)).json()) as Manifest;
    const arrays = await loadArrays(manifest, dirOf(manifestUrl), signal);
    return { viewId: created.view_id, manifest, ...arrays, fromCache };
  },
};
