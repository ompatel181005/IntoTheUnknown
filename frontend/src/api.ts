// Client for the backend contract in docs/PLAN.md section 4.3. No mock data here.
import type { Catalog, Health, LightCurve, Spectrum, Target, ViewCreated, ViewRequest, ViewStatus } from "./types";

export const API_BASE: string = (import.meta.env.VITE_API_BASE as string | undefined) ?? "";

// A static golden render has no live job yet. Register it lazily only for measurements,
// so image loading still works with the API stopped.
const goldenQueries = new Map<string, ViewRequest>();
const measurementViews = new Map<string, string>();
export function registerGoldenView(renderId: string, query: ViewRequest): void {
  goldenQueries.set(renderId, query);
}

async function measurementViewId(id: string, signal?: AbortSignal): Promise<string> {
  const query = goldenQueries.get(id);
  if (!query) return id;
  const cached = measurementViews.get(id);
  if (cached) return cached;
  const created = await createView(query, signal);
  const deadline = Date.now() + 120_000;
  let status = created.status;
  while (status !== "ready") {
    signal?.throwIfAborted();
    if (!created.status_url || Date.now() >= deadline) throw new ApiRequestError("TIMEOUT", "The measurement view is still preparing. Try again shortly.");
    await new Promise((resolve) => setTimeout(resolve, 300));
    const current = await getViewStatus(created.status_url, signal);
    if (current.status === "error") throw new ApiRequestError(current.error?.code ?? "PIPELINE_ERROR", current.error?.message ?? "The measurement view could not be prepared.");
    if (current.status === "ready") status = "ready";
  }
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

/** Static file in frontend/public/catalog, like /golden: the home sky needs no backend route. */
export function getCatalog(setName = "targets", signal?: AbortSignal): Promise<Catalog> {
  return request(`/catalog/${encodeURIComponent(setName)}.json`, { signal }).then((r) => json<Catalog>(r));
}

/** Per-frame values at one grid pixel for one epoch (x, y in FITS orientation, row 0 = south). */
export async function getSpectrum(viewId: string, x: number, y: number, epoch: number, signal?: AbortSignal): Promise<Spectrum> {
  viewId = await measurementViewId(viewId, signal);
  const q = new URLSearchParams({ x: String(x), y: String(y), epoch: String(epoch) });
  return request(`/api/views/${viewId}/spectrum?${q}`, { signal }).then((r) => json<Spectrum>(r));
}

/** Forced aperture photometry on every frame at one grid position. */
export async function getLightCurve(viewId: string, x: number, y: number, signal?: AbortSignal): Promise<LightCurve> {
  viewId = await measurementViewId(viewId, signal);
  const q = new URLSearchParams({ x: String(x), y: String(y) });
  return request(`/api/views/${viewId}/lightcurve?${q}`, { signal }).then((r) => json<LightCurve>(r));
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
