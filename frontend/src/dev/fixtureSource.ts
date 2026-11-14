// DEV ONLY. Synthetic sky for building the UI before the backend exists. Loaded by dev.html,
// never imported by production code. Every view it returns is labeled "DEV FIXTURE".
import type { LoadedView, ViewSource } from "../data/source";
import type { Epoch, Manifest } from "../types";

const N = 59;
const PIX = 6.15;

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gauss(r: () => number) {
  return Math.sqrt(-2 * Math.log(r() || 1e-9)) * Math.cos(2 * Math.PI * r());
}

function addStar(img: Float32Array, x: number, y: number, flux: number, sigma = 1.05) {
  const r = Math.ceil(sigma * 4);
  for (let j = Math.floor(y) - r; j <= Math.floor(y) + r; j++) {
    for (let i = Math.floor(x) - r; i <= Math.floor(x) + r; i++) {
      if (i < 0 || j < 0 || i >= N || j >= N) continue;
      const d2 = (i - x) ** 2 + (j - y) ** 2;
      img[j * N + i] += (flux / (2 * Math.PI * sigma * sigma)) * Math.exp(-d2 / (2 * sigma * sigma));
    }
  }
}

function build(ra: number, dec: number, epochCount: number): LoadedView {
  const r = rng(Math.round(ra * 1000 + dec * 7919));
  const field = Array.from({ length: 28 }, () => ({ x: r() * N, y: r() * N, f: 40 + r() ** 3 * 2400 }));
  const labels = ["2025-04", "2025-10", "2026-04", "2026-10", "2027-04"];
  const images: Float32Array[] = [];
  const masks: Uint8Array[] = [];
  const epochs: Epoch[] = [];
  for (let e = 0; e < epochCount; e++) {
    const img = new Float32Array(N * N);
    for (let k = 0; k < img.length; k++) img[k] = gauss(r);
    field.forEach((s) => addStar(img, s.x, s.y, s.f));
    // The mover: starts at the centre and hops north (row index up, FITS orientation) each pass.
    addStar(img, (N - 1) / 2, (N - 1) / 2 + e * 0.85, 1800);
    const mask = new Uint8Array(N * N);
    for (let k = 0; k < 3 + e; k++) mask[Math.floor(r() * N * N)] = 1;
    images.push(img);
    masks.push(mask);
    const mjd = 60770 + e * 182;
    epochs.push({
      i: e,
      label: labels[e] ?? `E${e + 1}`,
      t_start: "",
      t_end: "",
      t_mean_mjd: mjd,
      n_frames: 30 + e * 2,
      detectors: [1, 2],
      lambda_um: [0.75, 1.62],
      channels: 30,
      flagged_px: { HOT: 2 + e, PERSIST: 1 },
      astrom_resid_px: 0.07,
      phot_scale: 1,
      image: `e${e}.f32`,
      mask: `e${e}.mask.u8`,
    });
  }
  const manifest: Manifest = {
    schema: 1,
    render_key: `fixture-${ra.toFixed(4)}-${dec.toFixed(4)}-${epochCount}`,
    source: "golden",
    pipeline_version: 0,
    created_at: "",
    query: { ra, dec, fov_arcmin: 6, band: "auto" },
    grid: { nx: N, ny: N, pix_arcsec: PIX, wcs: {} },
    catalog: { version: "fixture", collections: ["synthetic"] },
    stretch: { kind: "asinh", vmin: -2, vmax: 60, beta: 3 },
    epochs,
    frames: [],
    extras: { gaia: null, lightcurve: null, cube: null },
  };
  return { viewId: manifest.render_key, manifest, images, masks, fromCache: false, label: "DEV FIXTURE" };
}

const wait = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new DOMException("aborted", "AbortError"));
    });
  });

/** ?fixture=slow | error | empty | single changes the behavior for checking each stage state. */
export const fixtureSource: ViewSource = {
  async load(q, onProgress, signal) {
    const mode = new URLSearchParams(window.location.search).get("fixture");
    const steps = mode === "slow" ? 40 : 4;
    for (let i = 1; i <= steps; i++) {
      onProgress({ stage: "fetch", done: i * 12, total: steps * 12 });
      await wait(mode === "slow" ? 250 : 120, signal);
    }
    if (mode === "error") {
      const err = new Error("IRSA did not answer in time. Try again in a minute.") as Error & { code: string };
      err.code = "IRSA_TIMEOUT";
      throw err;
    }
    return build(q.ra, q.dec, mode === "empty" ? 0 : mode === "single" ? 1 : 4);
  },
};
