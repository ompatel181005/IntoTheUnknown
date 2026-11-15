import { ApiRequestError, createView, fetchAsset, getViewStatus, registerGoldenView } from "../api";
import { findPreset } from "../lib/targets";
import type { Manifest, ViewRequest, ViewStage } from "../types";

export interface LoadedView {
  viewId: string;
  manifest: Manifest;
  images: Float32Array[];
  masks: (Uint8Array | null)[];
  /** True when served from a cache layer (golden snapshot or an already-rendered view). */
  fromCache: boolean;
  /** Set only when bundled golden snapshot assets actually supplied this view. */
  cacheLayer?: "snapshot";
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
  manifestUrl?: string;
}

/** Where views come from. Production uses apiSource; the dev page swaps in a fixture. */
export interface ViewSource {
  load(q: ViewQuery, onProgress: (p: LoadProgress) => void, signal: AbortSignal): Promise<LoadedView>;
}

const FIRST_POLL_MS = 350;
const POLL_MS = 1500;

function throwIfAborted(signal: AbortSignal) {
  if (signal.aborted) throw new DOMException("aborted", "AbortError");
}

function wait(ms: number, signal: AbortSignal) {
  throwIfAborted(signal);
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(t);
      signal.removeEventListener("abort", onAbort);
      reject(new DOMException("aborted", "AbortError"));
    };
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
    // Close the race where abort happens between the initial check and listener registration.
    if (signal.aborted) onAbort();
  });
}

async function loadArrays(m: Manifest, base: string, signal: AbortSignal) {
  const assetUrl = (path: string) => /^(https?:|\/)/.test(path) ? path : base + path;
  throwIfAborted(signal);
  const arrays = await Promise.all(m.epochs.map(async (e) => {
    const imagePromise = fetchAsset(assetUrl(e.image), signal).then(async (response) => {
      const buffer = await response.arrayBuffer();
      throwIfAborted(signal);
      return new Float32Array(buffer);
    });
    const maskPromise = !e.mask ? Promise.resolve(null) : fetchAsset(assetUrl(e.mask), signal)
      .then(async (response) => {
        const buffer = await response.arrayBuffer();
        throwIfAborted(signal);
        return new Uint8Array(buffer);
      })
      .catch((error: unknown) => {
        if (signal.aborted || (error as { name?: string } | null)?.name === "AbortError") throw error;
        return null; // A missing mask only disables the flag overlay.
      });
    const [image, mask] = await Promise.all([imagePromise, maskPromise]);
    return { image, mask };
  }));
  throwIfAborted(signal);
  const images = arrays.map(({ image }) => image);
  const masks = arrays.map(({ mask }) => mask);
  return { images, masks };
}

const dirOf = (url: string) => url.slice(0, url.lastIndexOf("/") + 1);

function viewRequest(q: ViewQuery): ViewRequest {
  return { ra: q.ra, dec: q.dec, fov_arcmin: q.fov_arcmin, band: q.band, mode: q.mode, source: q.source };
}

/** URLs round coordinates to five decimals; never accept a different field or band. */
export function matchesManifestQuery(value: unknown, q: ViewRequest): boolean {
  if (!value || typeof value !== "object") return false;
  const actual = value as Record<string, unknown>;
  return typeof actual.ra === "number" && Number.isFinite(actual.ra)
    && typeof actual.dec === "number" && Number.isFinite(actual.dec)
    && Math.abs(actual.ra - q.ra) < 0.0000051 && Math.abs(actual.dec - q.dec) < 0.0000051
    && actual.fov_arcmin === q.fov_arcmin && actual.band === q.band;
}

/** docs/PLAN.md 4.4: presets in their default view load from /golden first, which needs no backend. */
async function tryGolden(q: ViewQuery, signal: AbortSignal): Promise<LoadedView | null> {
  throwIfAborted(signal);
  const p = findPreset(q.presetId);
  if (!p || p.ra !== q.ra || p.dec !== q.dec || p.fov !== q.fov_arcmin || p.band !== q.band || q.source === "live") return null;
  const base = `/golden/${p.id}/`;
  let res: Response;
  try {
    res = await fetch(`${base}manifest.json`, { signal });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    return null;
  }
  throwIfAborted(signal);
  if (!res.ok || !(res.headers.get("content-type") ?? "").includes("json")) return null;
  const manifest = (await res.json()) as Manifest;
  const arrays = await loadArrays(manifest, base, signal);
  registerGoldenView(manifest.render_key, viewRequest(q));
  return { viewId: manifest.render_key, manifest, ...arrays, fromCache: true, cacheLayer: "snapshot" };
}

export const apiSource: ViewSource = {
  async load(q, onProgress, signal) {
    throwIfAborted(signal);
    const golden = await tryGolden(q, signal);
    if (golden) return golden;
    if (q.manifestUrl && q.source === "auto") {
      onProgress({ stage: "fetch" });
      const manifest = (await (await fetchAsset(q.manifestUrl, signal)).json()) as Manifest;
      throwIfAborted(signal);
      if (!matchesManifestQuery(manifest?.query, q)) throw new ApiRequestError("BAD_RESPONSE", "Prepared images do not match the requested position, field of view or band.");
      const arrays = await loadArrays(manifest, dirOf(q.manifestUrl), signal);
      registerGoldenView(manifest.render_key, viewRequest(q));
      return { viewId: manifest.render_key, manifest, ...arrays, fromCache: true };
    }

    onProgress({ stage: "queued" });
    const created = await createView(viewRequest(q), signal);
    let manifestUrl = created.manifest_url;
    const fromCache = created.status === "ready";
    let pollDelay = FIRST_POLL_MS;
    while (!manifestUrl) {
      if (!created.status_url) throw new ApiRequestError("BAD_RESPONSE", "Could not track progress. Try again.");
      await wait(pollDelay, signal);
      pollDelay = POLL_MS;
      const s = await getViewStatus(created.status_url, signal);
      throwIfAborted(signal);
      if (s.status === "error") throw new ApiRequestError(s.error?.code ?? "ERROR", s.error?.message ?? "Could not build this view. Try again.");
      onProgress({ stage: s.status, done: s.progress?.done, total: s.progress?.total });
      if (s.status === "ready") manifestUrl = s.manifest_url;
    }
    const manifest = (await (await fetchAsset(manifestUrl, signal)).json()) as Manifest;
    const arrays = await loadArrays(manifest, dirOf(manifestUrl), signal);
    return { viewId: created.view_id, manifest, ...arrays, fromCache };
  },
};
