import type { LoadedView } from "../data/source";
import type { Manifest } from "../types";
import { renderEpoch } from "../lib/stretch";
import { PRESETS } from "../lib/targets";
import { content, names } from "./content";
import { learnSearch, type LearnState } from "./state";

/** Pure metadata used by both the UI and exported evidence. Dates remain UTC. */
export function epochEvidence(manifest: Manifest, index: number) {
  const e = manifest.epochs[index];
  return {
    dates: `${e.t_start.slice(0, 10)} → ${e.t_end.slice(0, 10)} UTC`,
    wavelength: `${e.lambda_um[0]}–${e.lambda_um[1]} µm`,
    frames: e.n_frames,
    flags: Object.entries(e.flagged_px).map(([name, count]) => `${name}: ${count}`).join(" · "),
  };
}

export function advancedLink(manifest: Manifest, epoch: number, selection: [number, number] | null): string {
  const q = manifest.query;
  const p = new URLSearchParams({ ra: String(q.ra), dec: String(q.dec), fov: String(q.fov_arcmin), band: q.band, src: "saved", epoch: String(epoch + 1) });
  const preset = PRESETS.find(target => target.ra === q.ra && target.dec === q.dec && target.fov === q.fov_arcmin && target.band === q.band);
  if (preset) p.set("target", preset.id);
  if (selection) p.set("sel", selection.join(","));
  return `/${"?" + p}`;
}

export function epochCanvas(view: LoadedView, epoch: number): HTMLCanvasElement {
  const { nx, ny } = view.manifest.grid;
  const image = new ImageData(nx, ny);
  renderEpoch(image.data, view.images[epoch], nx, ny, view.manifest.stretch, "asinh", false);
  const canvas = document.createElement("canvas");
  canvas.width = nx; canvas.height = ny;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas unavailable");
  ctx.putImageData(image, 0, 0);
  return canvas;
}

export async function observationPng(view: LoadedView, state: LearnState, origin: string): Promise<Blob> {
  await document.fonts.ready;
  const t = content[state.lang];
  const root = getComputedStyle(document.documentElement);
  const token = (key: string) => root.getPropertyValue(key).trim();
  const canvas = document.createElement("canvas");
  canvas.width = 1200; canvas.height = 1800;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas unavailable");
  ctx.fillStyle = token("--space-0"); ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = token("--text-1");
  const font = '"Manrope Variable", "Nirmala UI", sans-serif';
  ctx.font = `600 32px ${font}`;
  ctx.fillText(`${names[state.mission]} · ${t.evidence}`, 40, 54);
  ctx.font = `22px ${font}`;
  ctx.fillStyle = token("--text-2");
  ctx.fillText(t.saved, 40, 92);
  const indices = [...new Set([0, Math.floor((view.images.length - 1) / 2), view.images.length - 1])];
  for (const [position, index] of indices.entries()) {
    const x = 40 + position * 380;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(epochCanvas(view, index), x, 125, 350, 350);
    if (state.selection) {
      const { nx, ny } = view.manifest.grid;
      const sx = x + (state.selection[0] + 0.5) / nx * 350;
      const sy = 125 + (ny - state.selection[1] - 0.5) / ny * 350;
      ctx.strokeStyle = token("--mover"); ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(sx, sy, 9, 0, Math.PI * 2); ctx.stroke();
    }
    const evidence = epochEvidence(view.manifest, index);
    ctx.fillStyle = token("--text-1"); ctx.font = `18px ${font}`;
    ctx.font = `16px ${font}`;
    ctx.fillText(evidence.dates, x, 505);
    ctx.font = `18px ${font}`;
    ctx.fillText(evidence.wavelength, x, 534);
    ctx.fillText(`${t.frames}: ${evidence.frames}`, x, 563);
  }
  let y = 610;
  function paragraph(text: string, maxWidth = 1110) {
    let line = "";
    for (const word of text.split(/\s+/)) {
      if (ctx!.measureText(word).width > maxWidth) {
        if (line) { ctx!.fillText(line, 40, y); y += 31; line = ""; }
        for (const character of word) {
          if (ctx!.measureText(line + character).width > maxWidth && line) {
            ctx!.fillText(line, 40, y); y += 31; line = "";
          }
          line += character;
        }
        continue;
      }
      const candidate = line ? `${line} ${word}` : word;
      if (ctx!.measureText(candidate).width > maxWidth && line) {
        ctx!.fillText(line, 40, y); y += 31; line = word;
      } else line = candidate;
    }
    ctx!.fillText(line, 40, y); y += 45;
  }
  ctx.font = `21px ${font}`; ctx.fillStyle = token("--text-1");
  paragraph(t.lessons[state.mission].limit);
  paragraph(state.mission === "motion" ? t.validated : t.unvalidated);
  paragraph(t.sharedStretch);
  if (state.selection) paragraph(`${t.selection}: ${state.selection.join(", ")} · ${t.annotation}`);
  ctx.font = `18px ${font}`; ctx.fillStyle = token("--text-2");
  paragraph(`${t.credits} · ${t.source} · ${view.manifest.render_key}`);
  paragraph(`${origin}/learn.html${learnSearch(state)}`);
  const cropped = document.createElement("canvas");
  cropped.width = canvas.width; cropped.height = Math.min(canvas.height, y + 28);
  const output = cropped.getContext("2d");
  if (!output) throw new Error("Canvas unavailable");
  output.drawImage(canvas, 0, 0);
  return new Promise((resolve, reject) => cropped.toBlob(blob => blob ? resolve(blob) : reject(new Error("PNG unavailable")), "image/png"));
}
