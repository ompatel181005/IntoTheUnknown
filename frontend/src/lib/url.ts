import { BAND_OPTIONS, FOV_OPTIONS, type Band, type DataSource, type FovArcmin } from "../types";

export type ViewMode = "all" | "blink" | "diff" | "inspect";
/** Tabs of the right-hand details drawer (null = closed). */
export type Panel = "pass" | "colours" | "brightness" | "files" | "sky";
export type StretchKind = "asinh" | "linear";

export interface Overlays {
  gaia: boolean;
  flags: boolean;
  grid: boolean;
}

/** Everything the share link carries. The URL is the state. */
export interface ViewState {
  ra: number | null;
  dec: number | null;
  fov: FovArcmin;
  band: Band;
  source: DataSource;
  /** Preset id when the view came from a target chip. */
  target: string | null;
  point: string | null;
  mode: ViewMode;
  /** Zero-based epoch index (written 1-based in the URL). */
  epoch: number;
  panel: Panel | null;
  speed: number;
  stretch: StretchKind;
  invert: boolean;
  /** Smooth the display (bilinear). Off shows SPHEREx's raw 6.15 arcsec pixels. */
  smooth: boolean;
  /** Multiplies the shared stretch's upper limit (lower = brighter). */
  gain: number;
  /** Reference epoch for Difference and Blink (zero-based). */
  ref: number;
  /** Selected grid pixel for measurements, FITS orientation (row 0 = south). */
  sel: [number, number] | null;
  overlays: Overlays;
}

export const DEFAULTS: Omit<ViewState, "ra" | "dec" | "target" | "point"> = {
  fov: 6,
  band: "auto",
  source: "auto",
  mode: "all",
  epoch: 0,
  panel: null,
  speed: 2,
  stretch: "asinh",
  invert: false,
  smooth: true,
  gain: 1,
  ref: 0,
  sel: null,
  overlays: { gaia: true, flags: false, grid: false },
};

export const GAINS = [0.25, 0.5, 1, 2] as const;

export const SPEEDS = [0.5, 1, 2, 4, 8] as const;
const MODES: ViewMode[] = ["all", "blink", "diff", "inspect"];
const PANELS: Panel[] = ["pass", "colours", "brightness", "files", "sky"];

function num(v: string | null): number | null {
  if (v === null || v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function parseUrl(search: string): ViewState {
  const p = new URLSearchParams(search);
  const ra = num(p.get("ra"));
  const dec = num(p.get("dec"));
  const fov = num(p.get("fov"));
  const band = p.get("band");
  const mode = p.get("mode");
  const panel = p.get("panel");
  const speed = num(p.get("speed"));
  const epoch = num(p.get("epoch"));
  const ov = p.get("ov");
  const gain = num(p.get("gain"));
  const ref = num(p.get("ref"));
  const selRaw = (p.get("sel") ?? "").split(",").map(Number);
  const sel: [number, number] | null =
    selRaw.length === 2 && selRaw.every((v) => Number.isInteger(v) && v >= 0) ? [selRaw[0], selRaw[1]] : null;
  const hasCoords = ra !== null && dec !== null && ra >= 0 && ra < 360 && dec >= -90 && dec <= 90;
  return {
    ra: hasCoords ? ra : null,
    dec: hasCoords ? dec : null,
    target: hasCoords ? p.get("target") : null,
    point: p.get("point") || null,
    fov: FOV_OPTIONS.includes(fov as FovArcmin) ? (fov as FovArcmin) : DEFAULTS.fov,
    band: BAND_OPTIONS.includes(band as Band) ? (band as Band) : DEFAULTS.band,
    source: (["auto", "saved", "live"] as const).find((v) => v === p.get("src")) ?? DEFAULTS.source,
    mode: MODES.includes(mode as ViewMode) ? (mode as ViewMode) : DEFAULTS.mode,
    panel: PANELS.includes(panel as Panel) ? (panel as Panel) : null,
    epoch: epoch !== null && epoch >= 1 ? Math.floor(epoch) - 1 : 0,
    speed: SPEEDS.includes(speed as (typeof SPEEDS)[number]) ? (speed as number) : DEFAULTS.speed,
    stretch: p.get("stretch") === "linear" ? "linear" : "asinh",
    invert: p.get("invert") === "1",
    smooth: p.get("raw") !== "1",
    gain: GAINS.includes(gain as (typeof GAINS)[number]) ? (gain as number) : DEFAULTS.gain,
    ref: ref !== null && ref >= 1 ? Math.floor(ref) - 1 : 0,
    sel,
    overlays:
      ov === null
        ? DEFAULTS.overlays
        : { gaia: ov.includes("g"), flags: ov.includes("f"), grid: ov.includes("r") },
  };
}

export function toSearch(s: ViewState): string {
  const p = new URLSearchParams(window.location.search);
  const set = (k: string, v: string | null) => (v === null ? p.delete(k) : p.set(k, v));
  set("ra", s.ra === null ? null : s.ra.toFixed(5));
  set("dec", s.dec === null ? null : s.dec.toFixed(5));
  set("fov", String(s.fov));
  set("target", s.target);
  set("point", s.point);
  set("band", s.band === DEFAULTS.band ? null : s.band);
  set("src", s.source === DEFAULTS.source ? null : s.source);
  set("mode", s.mode === DEFAULTS.mode ? null : s.mode);
  set("epoch", s.epoch === 0 ? null : String(s.epoch + 1));
  set("panel", s.panel);
  set("speed", s.speed === DEFAULTS.speed ? null : String(s.speed));
  set("stretch", s.stretch === DEFAULTS.stretch ? null : s.stretch);
  set("invert", s.invert ? "1" : null);
  set("raw", s.smooth ? null : "1");
  set("gain", s.gain === DEFAULTS.gain ? null : String(s.gain));
  set("ref", s.ref === 0 ? null : String(s.ref + 1));
  set("sel", s.sel ? s.sel.join(",") : null);
  const ov = (s.overlays.gaia ? "g" : "") + (s.overlays.flags ? "f" : "") + (s.overlays.grid ? "r" : "");
  const ovDefault = (DEFAULTS.overlays.gaia ? "g" : "") + (DEFAULTS.overlays.flags ? "f" : "") + (DEFAULTS.overlays.grid ? "r" : "");
  set("ov", ov === ovDefault ? null : ov || "-");
  const out = p.toString();
  return out ? `?${out}` : "";
}
