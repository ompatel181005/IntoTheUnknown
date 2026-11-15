import type { LoadedView } from "../data/source";
import { PRESETS, type Preset } from "./targets";

export interface SourcePresentation { label: string; cache: string; note: string }

/** Origin describes the data, not current archive health or a per-pixel transport. */
export function sourcePresentation(view: LoadedView): SourcePresentation {
  if (view.label) return { label: view.label, cache: "Development data", note: "Synthetic example for development." };
  const m = view.manifest;
  const saved = m.origin?.kind === "saved" || m.source === "golden";
  const label = saved ? "Saved SPHEREx cutouts" : m.origin?.kind === "live" || m.source === "irsa" || m.source === "s3"
    ? "Archive-sourced SPHEREx cutouts" : "Data origin not reported";
  const cache = view.cacheLayer === "snapshot" ? "Saved snapshot · cached" : view.fromCache ? "Cached render" : "New render";
  const note = view.cacheLayer === "snapshot" ? "Precomputed saved observations; no archive connection is needed to view these images."
    : view.fromCache ? "Previously prepared images; see pass details for observation dates."
    : "Prepared from the input observations in pass details.";
  return { label, cache, note };
}

export function utcTime(value: string | null | undefined): string {
  if (typeof value !== "string" || !value.trim()) return "Not reported";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Not reported" : date.toISOString().slice(0, 16).replace("T", " ");
}

export function astrometricScatter(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? `${value.toFixed(4)} px per axis` : "Not measured";
}

export function differenceLabel(mode: string, count: number, index: number, reference: number): string {
  const ref = Math.min(reference, count - 1);
  return mode === "diff" && count > 1 && index !== ref ? `, difference from pass ${ref + 1}` : "";
}

/** Recovery may change FOV/band, but never masquerade as the original request. */
export function savedRecovery(ra: number | null, dec: number | null): Preset | undefined {
  return PRESETS.find(p => p.ra === ra && p.dec === dec);
}

/** Editable target IDs are labels only when their actual centre also matches. */
export function centeredPreset(id: string | null, ra: number | null, dec: number | null): Preset | undefined {
  return PRESETS.find(p => p.id === id && p.ra === ra && p.dec === dec);
}

export function savedPresetLink(preset: Preset): string {
  const params = new URLSearchParams({ ra: String(preset.ra), dec: String(preset.dec), target: preset.id,
    fov: String(preset.fov), band: preset.band, src: "saved", mode: "all", epoch: "1", ref: "1" });
  return `/?${params}`;
}

export function viewErrorCopy(code: string) {
  if (code === "QUEUE_FULL") return { title: "Render queue full", advice: "Wait briefly, then retry. Your request was not added to the render queue." };
  if (code === "HTTP_429") return { title: "Server busy", advice: "The server rejected this request. Wait briefly before retrying." };
  if (code === "IRSA_DOWN") return { title: "Archive unavailable for this request", advice: "Retry the archive, or open a saved default view when one is available below." };
  if (code === "NOT_SAVED") return { title: "No saved cutouts for this selection", advice: "Choose a saved example, or change the source to Auto or Live to request archive data." };
  return { title: "Could not load this view", advice: "Try again, or choose another position." };
}
