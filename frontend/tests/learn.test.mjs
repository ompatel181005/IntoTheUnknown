import assert from "node:assert/strict";
import { test, after } from "node:test";
import { readFile } from "node:fs/promises";
import { createServer } from "vite";

const server = await createServer({ server: { middlewareMode: true }, appType: "custom" });
after(() => server.close());
const { parseLearnState, learnSearch, imagePixel, validSelection } = await server.ssrLoadModule("/src/learn/state.ts");
const { content, targets } = await server.ssrLoadModule("/src/learn/content.ts");
const { epochEvidence, advancedLink } = await server.ssrLoadModule("/src/learn/postcard.ts");
const { renderEpoch } = await server.ssrLoadModule("/src/lib/stretch.ts");
const { loadLearnTarget } = await server.ssrLoadModule("/src/data/learnSource.ts");

test("shared state round trips language, mission, epoch and scientific pixel", () => {
  for (const lang of ["en", "es", "hi"]) {
    const state = { lang, mission: "uncertainty", epoch: 2, selection: [12, 45] };
    assert.deepEqual(parseLearnState(learnSearch(state)), state);
  }
  assert.deepEqual(parseLearnState("?lang=xx&mission=unknown&epoch=-4&sel=,"), { lang: "en", mission: "motion", epoch: 0, selection: null });
  assert.equal(parseLearnState("?sel=1,NaN").selection, null);
  assert.equal(validSelection([59, 2], 59, 59), null);
});

test("north-up annotation agrees with actual array orientation", () => {
  const out = new Uint8ClampedArray(16);
  renderEpoch(out, new Float32Array([0, 1, 2, 3]), 2, 2, { vmin: 0, vmax: 3, beta: 1, kind: "asinh" }, "linear", false);
  assert.equal(out[0], 170); // top-left is scientific (0,1), value2
  assert.equal(out[8], 0); // bottom-left is scientific (0,0)
  assert.deepEqual(imagePixel(0, 0, 2, 2), [0, 1]);
  assert.deepEqual(imagePixel(1, 1, 2, 2), [1, 0]);
});

test("postcard metadata and advanced link use the actual saved manifests", async () => {
  for (const target of Object.values(targets)) {
    const m = JSON.parse(await readFile(new URL(`../public/golden/${target}/manifest.json`, import.meta.url), "utf8"));
    assert.equal(m.epochs.length, 3);
    for (const [i, epoch] of m.epochs.entries()) {
      const card = epochEvidence(m, i);
      assert.equal(card.frames, epoch.n_frames);
      assert.equal(card.wavelength, `${epoch.lambda_um[0]}–${epoch.lambda_um[1]} µm`);
      assert.ok(card.dates.includes(epoch.t_start.slice(0, 10)) && card.dates.includes(epoch.t_end.slice(0, 10)));
      const bytes = await readFile(new URL(`../public/golden/${target}/${epoch.image}`, import.meta.url));
      assert.equal(bytes.byteLength, m.grid.nx * m.grid.ny * 4);
    }
    const url = new URL(advancedLink(m, 2, [8, 9]), "https://example.invalid");
    assert.equal(url.searchParams.get("ra"), String(m.query.ra));
    assert.equal(url.searchParams.get("dec"), String(m.query.dec));
    assert.equal(url.searchParams.get("band"), m.query.band);
    assert.equal(url.searchParams.get("src"), "saved");
    assert.equal(url.searchParams.get("target"), target);
    assert.equal(url.searchParams.get("sel"), "8,9");
  }
});

test("every locale contains every UI and activity string", () => {
  for (const lang of ["es", "hi"]) {
    assert.deepEqual(Object.keys(content[lang]).sort(), Object.keys(content.en).sort());
    for (const [key, value] of Object.entries(content[lang])) {
      if (key !== "lessons") assert.ok(typeof value === "string" && value.trim());
    }
    for (const mission of ["motion", "wavelength", "uncertainty"]) {
      assert.deepEqual(Object.keys(content[lang].lessons[mission]).sort(), Object.keys(content.en.lessons[mission]).sort());
      assert.ok(Object.values(content[lang].lessons[mission]).every(value => typeof value === "string" && value.trim()));
    }
  }
});

test("learning loader uses exact WISE assets and never falls back to a build", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push(url);
    assert.ok(url.startsWith("/golden/wise-0855/"));
    assert.ok(options.signal instanceof AbortSignal);
    const name = url.split("/").at(-1);
    return new Response(await readFile(new URL(`../public/golden/wise-0855/${name}`, import.meta.url)));
  });
  const view = await loadLearnTarget("wise-0855", new AbortController().signal);
  assert.equal(view.manifest.query.ra, 133.7599);
  assert.equal(view.manifest.query.dec, -7.2422);
  assert.equal(view.images.length, view.manifest.epochs.length);
  assert.equal(calls.length, 1 + view.images.length + view.masks.length);
  t.mock.restoreAll();
  t.mock.method(globalThis, "fetch", async url => {
    assert.equal(url, "/golden/wise-0855/manifest.json");
    return new Response("missing", { status: 404 });
  });
  await assert.rejects(loadLearnTarget("wise-0855", new AbortController().signal));
});

test("mask requests start before image reads complete; cancellation is checked after reads", { timeout: 2000 }, async (t) => {
  const m = JSON.parse(await readFile(new URL("../public/golden/wise-0855/manifest.json", import.meta.url), "utf8"));
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let maskRequests = 0;
  t.mock.method(globalThis, "fetch", async url => {
    if (url.endsWith("manifest.json")) return new Response(JSON.stringify(m));
    if (url.endsWith(".f32")) return { ok: true, arrayBuffer: async () => { await gate; return new ArrayBuffer(m.grid.nx * m.grid.ny * 4); } };
    maskRequests++;
    if (maskRequests === m.epochs.length) release();
    return new Response(new Uint8Array(m.grid.nx * m.grid.ny));
  });
  await loadLearnTarget("wise-0855", new AbortController().signal);
  assert.equal(maskRequests, m.epochs.length);
  t.mock.restoreAll();
  const controller = new AbortController();
  t.mock.method(globalThis, "fetch", async url => {
    if (url.endsWith("manifest.json")) return new Response(JSON.stringify(m));
    return { ok: true, arrayBuffer: async () => { controller.abort(); return new ArrayBuffer(url.endsWith(".f32") ? m.grid.nx * m.grid.ny * 4 : m.grid.nx * m.grid.ny); } };
  });
  await assert.rejects(loadLearnTarget("wise-0855", controller.signal), { name: "AbortError" });
});
