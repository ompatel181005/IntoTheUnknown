// Client for the backend contract in docs/PLAN.md section 4.3. No mock data here.
import type { Catalog, GaiaResult, GaiaSelection, Health, LightCurve, Spectrum, Target, ViewCreated, ViewRequest, ViewStatus } from "./types";
import { validateCatalog } from "./lib/catalog";

export const API_BASE: string = (import.meta.env.VITE_API_BASE as string | undefined) ?? "";

// A static golden render has no live job yet. Register it lazily only for measurements,
// so image loading still works with the API stopped.
const goldenQueries = new Map<string, ViewRequest>();
const measurementViews = new Map<string, string>();
type Registration = { promise: Promise<string>; controller: AbortController; subscribers: number };
const registrations = new Map<string, Registration>();
const displayedRenders = new Map<string, string>();
export function registerMeasurementRender(viewId: string, renderKey: string): void {
  displayedRenders.set(viewId, renderKey);
}
export function registerGoldenView(renderId: string, query: ViewRequest): void {
  goldenQueries.set(renderId, query);
  registerMeasurementRender(renderId, renderId);
}

async function measurementViewId(id: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const query = goldenQueries.get(id);
  if (!query) return id;
  const cached = measurementViews.get(id);
  if (cached) return cached;
  let registration = registrations.get(id);
  if (!registration) {
    const controller = new AbortController();
    const next: Registration = { controller, subscribers: 0, promise: Promise.resolve("") };
    next.promise = prepareMeasurementView(id, query, controller.signal).finally(() => {
      if (registrations.get(id) === next) registrations.delete(id);
    });
    registrations.set(id, next);
    registration = next;
  }
  const shared = registration;
  shared.subscribers += 1;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    shared.subscribers -= 1;
    if (!shared.subscribers && registrations.get(id) === shared) {
      registrations.delete(id);
      shared.controller.abort();
    }
  };
  try {
    return await abortable(shared.promise, signal, release);
  } finally {
    release();
  }
}

/** One subscriber can leave without cancelling a measurement another panel still needs. */
function abortable<T>(pending: Promise<T>, signal?: AbortSignal, onAbort?: () => void): Promise<T> {
  if (!signal) return pending;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const aborted = () => { onAbort?.(); cleanup(); reject(signal.reason); };
    const cleanup = () => signal.removeEventListener("abort", aborted);
    signal.addEventListener("abort", aborted, { once: true });
    pending.then((value) => { cleanup(); resolve(value); }, (error) => { cleanup(); reject(error); });
  });
}

async function prepareMeasurementView(id: string, query: ViewRequest, signal: AbortSignal): Promise<string> {
  // StrictMode setup/cleanup happens in the same turn. Let an unused subscription
  // leave before starting a POST, rather than starting and immediately aborting it.
  await Promise.resolve();
  signal.throwIfAborted();
  const created = await createView(query, signal);
  const deadline = Date.now() + 120_000;
  let status = created.status;
  while (status !== "ready") {
    signal.throwIfAborted();
    if (!created.status_url || Date.now() >= deadline) throw new ApiRequestError("TIMEOUT", "The measurement view is still preparing. Try again shortly.");
    await abortable(new Promise((resolve) => setTimeout(resolve, 300)), signal);
    const current = await getViewStatus(created.status_url, signal);
    if (current.status === "error") throw new ApiRequestError(current.error?.code ?? "PIPELINE_ERROR", current.error?.message ?? "The measurement view could not be prepared.");
    if (current.status === "ready") status = "ready";
  }
  signal.throwIfAborted();
  measurementViews.set(id, created.view_id);
  return created.view_id;
}

export class ApiRequestError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let code = `HTTP_${res.status}`;
    let message = `The server answered ${res.status}.`;
    try {
      const body = (await res.json()) as { error?: { code?: string; message?: string } };
      if (body.error?.code) code = body.error.code;
      if (body.error?.message) message = body.error.message;
    } catch {
      // Body was not JSON; keep the status message.
    }
    throw new ApiRequestError(code, message);
  }
  return (await res.json()) as T;
}

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  try {
    return await fetch(`${API_BASE}${path}`, init);
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new ApiRequestError("NETWORK", "Could not connect. Check your connection and try again.");
  }
}

export function getHealth(signal?: AbortSignal): Promise<Health> {
  return request("/api/health", { signal }).then((r) => json<Health>(r));
}

export function getTargets(signal?: AbortSignal): Promise<Target[]> {
  return request("/api/targets", { signal }).then((r) => json<Target[]>(r));
}

const catalogLoads = new Map<string, Promise<Catalog>>();
const POINTS_URL = (import.meta.env.VITE_POINTS_URL as string | undefined)
  ?? "https://stplanetxitu7q4.blob.core.windows.net/frames/catalog/points.json";

/** Shared independently of component lifetimes, including StrictMode's first cleanup. */
export function getCatalog(setName = "points", signal?: AbortSignal, preferRemote = true): Promise<Catalog> {
  const key = `${setName}:${preferRemote}`;
  let pending = catalogLoads.get(key);
  if (!pending) {
    const urls = setName === "points"
      ? [...(preferRemote ? [POINTS_URL] : []), "/catalog/points.json", "/catalog/targets.json"]
      : [`/catalog/${encodeURIComponent(setName)}.json`];
    pending = (async () => {
      for (const url of urls) {
        try {
          const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
          if (!response.ok) continue;
          return validateCatalog(await response.json());
        } catch {
          // Missing, malformed, or unreachable catalogs fall through to the bundled set.
        }
      }
      throw new ApiRequestError("CATALOG", "Could not load the target list. Reload to try again.");
    })();
    catalogLoads.set(key, pending);
  }
  return pending.then((catalog) => {
    signal?.throwIfAborted();
    return catalog;
  });
}

/** Per-frame values at one grid pixel for one epoch (x, y in FITS orientation, row 0 = south). */
export async function getSpectrum(viewId: string, x: number, y: number, epoch: number, signal?: AbortSignal): Promise<Spectrum> {
  const renderKey = displayedRenders.get(viewId);
  viewId = await measurementViewId(viewId, signal);
  const q = new URLSearchParams({ x: String(x), y: String(y), epoch: String(epoch) });
  if (renderKey) q.set("render_key", renderKey);
  return request(`/api/views/${viewId}/spectrum?${q}`, { signal }).then((r) => json<Spectrum>(r));
}

/** Forced aperture photometry on every frame at one grid position. */
export async function getLightCurve(viewId: string, x: number, y: number, signal?: AbortSignal): Promise<LightCurve> {
  const renderKey = displayedRenders.get(viewId);
  viewId = await measurementViewId(viewId, signal);
  const q = new URLSearchParams({ x: String(x), y: String(y) });
  if (renderKey) q.set("render_key", renderKey);
  return request(`/api/views/${viewId}/lightcurve?${q}`, { signal }).then((r) => json<LightCurve>(r));
}

/** "Gaia match" label of the source at one grid position in one pass (null when the view has no label). */
export async function getGaiaMatch(viewId: string, x: number, y: number, epoch: number, signal?: AbortSignal): Promise<GaiaSelection | null> {
  const renderKey = displayedRenders.get(viewId);
  viewId = await measurementViewId(viewId, signal);
  const q = new URLSearchParams({ x: String(x), y: String(y), epoch: String(epoch) });
  if (renderKey) q.set("render_key", renderKey);
  return request(`/api/views/${viewId}/gaia?${q}`, { signal }).then((r) => json<GaiaResult>(r)).then((g) => g.selection ?? null);
}

export function createView(body: ViewRequest, signal?: AbortSignal): Promise<ViewCreated> {
  return request("/api/views", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  }).then((r) => json<ViewCreated>(r));
}

export function getViewStatus(statusUrl: string, signal?: AbortSignal): Promise<ViewStatus> {
  return request(statusUrl, { signal }).then((r) => json<ViewStatus>(r));
}

/** Fetch an absolute or API-relative URL (manifests and arrays live in Blob or /golden). */
export async function fetchAsset(url: string, signal?: AbortSignal): Promise<Response> {
  const full = /^https?:/.test(url) || url.startsWith("/golden/") ? url : `${API_BASE}${url}`;
  let res: Response;
  try {
    res = await fetch(full, { signal });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new ApiRequestError("NETWORK", "Could not download images. Check your connection and try again.");
  }
  if (!res.ok) throw new ApiRequestError(`HTTP_${res.status}`, `An image is missing (${res.status}). Try again later.`);
  return res;
}
