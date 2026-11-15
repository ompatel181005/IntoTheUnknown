import { fetchAsset } from "../api";
import type { LoadedView } from "./source";
import type { Manifest } from "../types";

export type LearnTarget = "barnard" | "rw-aur" | "wise-0855";

/** Fixed bundled assets only. No build endpoint, archive request, or network fallback. */
export async function loadLearnTarget(target: LearnTarget, signal: AbortSignal): Promise<LoadedView> {
  const base = `/golden/${target}/`;
  const manifest = await (await fetchAsset(`${base}manifest.json`, signal)).json() as Manifest;
  signal.throwIfAborted();
  const { nx, ny } = manifest.grid;
  if (!Number.isInteger(nx) || !Number.isInteger(ny) || nx < 1 || ny < 1 || nx * ny > 4096 * 4096 || !manifest.epochs.length) throw new Error("Invalid saved image");
  const asset = (name: string) => {
    if (!/^[a-zA-Z0-9_.-]+$/.test(name) || name.startsWith(".")) throw new Error("Invalid saved asset");
    return base + name;
  };
  const imageRequests = Promise.all(manifest.epochs.map(async e => {
    const bytes = await (await fetchAsset(asset(e.image), signal)).arrayBuffer();
    signal.throwIfAborted();
    if (bytes.byteLength !== nx * ny * 4) throw new Error("Incomplete saved image");
    return new Float32Array(bytes);
  }));
  const maskRequests = Promise.all(manifest.epochs.map(async e => {
    if (!e.mask) return null;
    const bytes = await (await fetchAsset(asset(e.mask), signal)).arrayBuffer();
    signal.throwIfAborted();
    if (bytes.byteLength !== nx * ny) throw new Error("Incomplete saved mask");
    return new Uint8Array(bytes);
  }));
  const [images, masks] = await Promise.all([imageRequests, maskRequests]);
  signal.throwIfAborted();
  return { viewId: manifest.render_key, manifest, images, masks, fromCache: true };
}
