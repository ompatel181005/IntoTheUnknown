import assert from "node:assert/strict";
import { after, test } from "node:test";
import { readFile } from "node:fs/promises";
import { createServer } from "vite";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const server = await createServer({ server: { middlewareMode: true }, appType: "custom" });
after(() => server.close());
const { sourcePresentation, loadingPresentation, utcTime, astrometricScatter, savedRecovery, savedPresetLink, viewErrorCopy, centeredPreset, differenceLabel } = await server.ssrLoadModule("/src/lib/viewPresentation.ts");
const { parseUrl } = await server.ssrLoadModule("/src/lib/url.ts");
const { PRESETS } = await server.ssrLoadModule("/src/lib/targets.ts");
const { Drawer } = await server.ssrLoadModule("/src/components/Drawer/Drawer.tsx");

test("loading distinguishes prepared files, archive waits, attempted cutouts and long-wait recovery", () => {
  const prepared = loadingPresentation({ stage: "fetch", path: "prepared" }, 35);
  assert.equal(prepared.title, "Loading prepared images");
  assert.match(prepared.detail, /does not check current archive availability/);
  assert.match(prepared.waiting, /another target/);
  const query = loadingPresentation({ stage: "query", path: "build" }, 15);
  assert.match(query.detail, /several minutes/);
  assert.equal(query.waiting, null);
  const fetch = loadingPresentation({ stage: "fetch", path: "build", done: 2, total: 4 }, 35);
  assert.match(fetch.detail, /unsuccessful attempts\. 2 \/ 4 completed/);
  assert.match(fetch.waiting, /shared server work may continue/);
  assert.doesNotMatch(fetch.detail, /percent|%|estimated|remaining/i);
});

test("saved snapshots, cached archive data and fresh saved renders are distinct", () => {
  const view = { fromCache: true, cacheLayer: "snapshot", manifest: { source: "golden", origin: { kind: "saved" } } };
  assert.equal(sourcePresentation(view).cache, "Saved snapshot · cached");
  assert.equal(sourcePresentation(view).label, "Saved SPHEREx cutouts");
  const freshSaved = sourcePresentation({ ...view, cacheLayer: undefined, fromCache: false });
  assert.equal(freshSaved.cache, "New render");
  assert.equal(freshSaved.label, "Saved SPHEREx cutouts");
  const cachedArchive = sourcePresentation({ fromCache: true, manifest: { source: "irsa", origin: { kind: "live" } } });
  assert.equal(cachedArchive.cache, "Cached render");
  assert.equal(cachedArchive.label, "Archive-sourced SPHEREx cutouts");
  assert.doesNotMatch(cachedArchive.label, /live|down|unavailable/i);
  assert.equal(sourcePresentation({ fromCache: false, manifest: {} }).label, "Data origin not reported");
  assert.equal(sourcePresentation({ ...view, label: "Synthetic fixture" }).cache, "Development data");
});

test("alignment scatter labels zero correctly and does not turn missing values into zero", () => {
  assert.equal(astrometricScatter(0), "0.0000 px per axis");
  assert.equal(astrometricScatter(0.0211), "0.0211 px per axis");
  for (const value of [null, undefined, NaN, Infinity, -1]) assert.equal(astrometricScatter(value), "Not measured");
  assert.equal(utcTime("2025-08-21T23:33:58+00:00"), "2025-08-21 23:33");
  assert.equal(utcTime("invalid"), "Not reported");
  assert.equal(utcTime(null), "Not reported");
  assert.equal(utcTime(undefined), "Not reported");
  assert.equal(utcTime("   "), "Not reported");
});

test("saved recovery resets every request to the exact real snapshot query", async () => {
  for (const p of PRESETS) {
    const recovery = savedRecovery(p.ra, p.dec);
    assert.equal(recovery.id, p.id);
    const link = new URL(savedPresetLink(recovery), "https://example.invalid");
    const state = parseUrl(link.search);
    const manifest = JSON.parse(await readFile(new URL(`../public/golden/${p.id}/manifest.json`, import.meta.url), "utf8"));
    assert.equal(state.target, p.id);
    assert.equal(state.source, "saved");
    assert.equal(state.ra, manifest.query.ra);
    assert.equal(state.dec, manifest.query.dec);
    assert.equal(state.fov, manifest.query.fov_arcmin);
    assert.equal(state.band, manifest.query.band);
    assert.equal(state.epoch, 0);
    assert.equal(state.sel, null);
    assert.equal(state.ref, 0);
    assert.equal(state.mode, "all");
  }
  assert.equal(savedRecovery(10, 10), undefined);
  assert.equal(savedRecovery(PRESETS[0].ra + 0.01, PRESETS[0].dec), undefined);
});

test("archive, queue and unknown throttling errors do not imply the same cause", () => {
  assert.equal(viewErrorCopy("QUEUE_FULL").title, "Render queue full");
  assert.equal(viewErrorCopy("HTTP_429").title, "Server busy");
  assert.match(viewErrorCopy("IRSA_DOWN").title, /Archive unavailable/);
  assert.doesNotMatch(viewErrorCopy("NOT_SAVED").title, /Archive unavailable/);
});

test("a URL target id cannot label another sky field", () => {
  const p = PRESETS[0];
  assert.equal(centeredPreset(p.id, p.ra, p.dec), p);
  assert.equal(centeredPreset(p.id, 10, 10), undefined);
  assert.equal(centeredPreset("unknown", p.ra, p.dec), undefined);
});

test("ordinary and single-pass images are not announced as differences", () => {
  assert.equal(differenceLabel("diff", 1, 0, 0), "");
  assert.equal(differenceLabel("diff", 3, 0, 0), "");
  assert.equal(differenceLabel("all", 3, 1, 0), "");
  assert.equal(differenceLabel("diff", 3, 1, 0), ", difference from pass 1");
  assert.equal(differenceLabel("diff", 3, 1, 99), ", difference from pass 3");
});

test("actual pass drawer renders UTC windows, missing scatter and overlapping flag explanation", async () => {
  const manifest = JSON.parse(await readFile(new URL("../public/golden/barnard/manifest.json", import.meta.url), "utf8"));
  manifest.epochs[0].astrom_resid_px = null;
  const noop = () => {};
  const html = renderToStaticMarkup(createElement(Drawer, { panel: "pass", onPanel: noop, onClose: noop,
    view: { manifest, fromCache: true, cacheLayer: "snapshot" }, index: 0, target: null, position: null, sel: null,
    spectrum: { kind: "idle" }, lightcurve: { kind: "idle" }, onSelectEpoch: noop }));
  assert.match(html, /Start \(UTC\)/);
  assert.match(html, /End \(UTC\)/);
  assert.match(html, /2025-08-21 23:33/);
  assert.match(html, /Not measured/);
  assert.match(html, /Saved snapshot · cached/);
  assert.match(html, /Categories overlap/);
  assert.match(html, /not object counts or a distinct-pixel total/);
  assert.doesNotMatch(html, />Flagged px</);
});
