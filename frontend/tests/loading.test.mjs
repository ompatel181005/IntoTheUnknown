import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function responseForArrayBuffer(buffer) {
  return { arrayBuffer: async () => buffer };
}

async function loadTypescriptModule(relativePath, exports, imports = {}, globals = {}) {
  const file = path.join(root, relativePath);
  const source = await readFile(file, "utf8");
  const javascript = ts.transpileModule(source.replaceAll("import.meta.env", "({})"), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const context = vm.createContext({ AbortController, DOMException, Float32Array, Uint8Array, setTimeout, clearTimeout, ...globals });
  const module = new vm.SourceTextModule(javascript, { context, identifier: file });
  await module.link((specifier) => {
    const definitions = imports[specifier];
    assert.ok(definitions, `Unexpected import ${specifier} from ${relativePath}`);
    return new vm.SyntheticModule(Object.keys(definitions), function initialize() {
      for (const [name, value] of Object.entries(definitions)) this.setExport(name, value);
    }, { context });
  });
  await module.evaluate();
  return { namespace: module.namespace, context };
}

async function loadApiSource(api, globals = {}) {
  const { namespace } = await loadTypescriptModule("src/data/source.ts", {}, {
    "../api": {
      ApiRequestError: class ApiRequestError extends Error {
        constructor(code, message) { super(message); this.code = code; }
      },
      createView: api.createView ?? (async () => ({ status: "ready", manifest_url: "/r/v/manifest.json", view_id: "v" })),
      fetchAsset: api.fetchAsset ?? (async () => { throw new Error("unexpected asset request"); }),
      getViewStatus: api.getViewStatus ?? (async () => { throw new Error("unexpected status request"); }),
      registerGoldenView: api.registerGoldenView ?? (() => {}),
      registerMeasurementRender: api.registerMeasurementRender ?? (() => {}),
    },
    "../lib/targets": { findPreset: api.findPreset ?? (() => null) },
  }, globals);
  return namespace.apiSource;
}

function query() {
  return { ra: 10, dec: 20, fov_arcmin: 2, band: "b1", source: "live", presetId: null };
}

test("starts image and mask fetches together and allows an absent mask", async () => {
  const image = deferred();
  const mask = deferred();
  const started = [];
  const source = await loadApiSource({
    fetchAsset: async (url) => {
      started.push(url);
      if (url.endsWith("manifest.json")) return { json: async () => ({ render_key: "r", epochs: [{ image: "e.f32", mask: "e.mask" }] }) };
      if (url.endsWith("e.f32")) return image.promise;
      return mask.promise;
    },
  });
  const load = source.load(query(), () => {}, new AbortController().signal);
  await new Promise((resolve) => setTimeout(resolve, 225));
  assert.deepEqual(started, ["/r/v/manifest.json", "/r/v/e.f32", "/r/v/e.mask"]);

  image.resolve(responseForArrayBuffer(new Float32Array([1, 2]).buffer));
  await new Promise((resolve) => setImmediate(resolve));
  mask.reject(new Error("404"));
  const result = await load;
  assert.deepEqual([...result.images[0]], [1, 2]);
  assert.equal(result.masks[0], null);
});

test("does not turn mask aborts into an optional missing mask", async () => {
  const source = await loadApiSource({
    fetchAsset: async (url) => {
      if (url.endsWith("manifest.json")) return { json: async () => ({ render_key: "r", epochs: [{ image: "e.f32", mask: "e.mask" }] }) };
      if (url.endsWith("e.f32")) return responseForArrayBuffer(new Float32Array([1]).buffer);
      throw new DOMException("aborted", "AbortError");
    },
  });
  await assert.rejects(source.load(query(), () => {}, new AbortController().signal), { name: "AbortError" });
});

test("rejects when a signal aborts while an asset body is being read", async () => {
  const body = deferred();
  const controller = new AbortController();
  const source = await loadApiSource({
    fetchAsset: async (url) => {
      if (url.endsWith("manifest.json")) return { json: async () => ({ render_key: "r", epochs: [{ image: "e.f32" }] }) };
      return { arrayBuffer: () => body.promise };
    },
  });
  const load = source.load(query(), () => {}, controller.signal);
  await new Promise((resolve) => setTimeout(resolve, 225));
  controller.abort();
  body.resolve(new Float32Array([1]).buffer);
  await assert.rejects(load, { name: "AbortError" });
});

test("pre-aborted loads reject before creating an API request", async () => {
  let requests = 0;
  const source = await loadApiSource({ createView: async () => { requests += 1; throw new Error("called"); } });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(source.load(query(), () => {}, controller.signal), { name: "AbortError" });
  assert.equal(requests, 0);
});

test("abort before submission drops obsolete queued work and cleans up its listener", async () => {
  let polls = 0;
  let posts = 0;
  const source = await loadApiSource({
    createView: async () => { posts += 1; return { status: "queued", status_url: "/status", view_id: "v" }; },
    getViewStatus: async () => { polls += 1; return { status: "queued" }; },
  });
  const controller = new AbortController();
  let added = 0;
  let removed = 0;
  const add = controller.signal.addEventListener.bind(controller.signal);
  const remove = controller.signal.removeEventListener.bind(controller.signal);
  controller.signal.addEventListener = (...args) => { added += 1; return add(...args); };
  controller.signal.removeEventListener = (...args) => { removed += 1; return remove(...args); };
  const load = source.load(query(), () => {}, controller.signal);
  await new Promise((resolve) => setTimeout(resolve, 25));
  controller.abort();
  await assert.rejects(load, { name: "AbortError" });
  assert.equal(added, 1);
  assert.equal(removed, 1);
  assert.equal(polls, 0);
  assert.equal(posts, 0);
});

test("uses a short first poll and the existing cadence afterward", async () => {
  const delays = [];
  let poll = 0;
  const source = await loadApiSource({
    createView: async () => ({ status: "queued", status_url: "/status", view_id: "v" }),
    getViewStatus: async () => {
      poll += 1;
      return poll === 1 ? { status: "queued" } : { status: "ready", manifest_url: "/r/v/manifest.json" };
    },
    fetchAsset: async () => ({ json: async () => ({ render_key: "r", epochs: [] }) }),
  }, { setTimeout: (callback, delay) => { delays.push(delay); return setImmediate(callback); }, clearTimeout: clearImmediate });
  await source.load(query(), () => {}, new AbortController().signal);
  assert.equal(poll, 2);
  assert.deepEqual(delays, [200, 350, 1500]);
});

test("aborting one submitted viewer stops its polling while another viewer completes the shared job", async () => {
  const first = new AbortController();
  const second = new AbortController();
  const posts = [];
  const polls = [];
  const sharedJob = { status: "queued", status_url: "/shared/status", view_id: "shared" };
  const source = await loadApiSource({
    createView: async (_q, signal) => { posts.push(signal); return sharedJob; },
    getViewStatus: async (_url, signal) => { polls.push(signal); return { status: "ready", manifest_url: "/shared/manifest.json" }; },
    fetchAsset: async () => ({ json: async () => ({ render_key: "shared", epochs: [] }) }),
  });
  const abandoned = source.load(query(), () => {}, first.signal);
  const remaining = source.load(query(), () => {}, second.signal);
  await new Promise((resolve) => setTimeout(resolve, 225));
  assert.equal(posts.length, 2);
  first.abort();
  await assert.rejects(abandoned, { name: "AbortError" });
  assert.equal((await remaining).viewId, "shared");
  assert.deepEqual(polls, [second.signal]);
  assert.equal(sharedJob.status, "queued"); // browser never mutates/cancels server ownership
});

test("ignores late progress and completion from a source that ignores abort", async () => {
  const pending = [];
  const hooks = { states: [], effects: [], cursor: 0, effectCursor: 0 };
  const useState = (initial) => {
    const slot = hooks.cursor++;
    if (!(slot in hooks.states)) hooks.states[slot] = initial;
    return [hooks.states[slot], (value) => { hooks.states[slot] = value; }];
  };
  const useEffect = (effect, deps) => {
    const slot = hooks.effectCursor++;
    const prior = hooks.effects[slot];
    if (!prior || deps.some((value, index) => value !== prior.deps[index])) {
      prior?.cleanup?.();
      hooks.effects[slot] = { deps, cleanup: effect() };
    }
  };
  const { namespace } = await loadTypescriptModule("src/hooks/useView.ts", {}, {
    react: { useEffect, useState },
  });
  const source = {
    load: (q, onProgress, signal) => {
      const request = deferred();
      pending.push({ request, onProgress, signal });
      return request.promise;
    },
  };
  const render = (ra) => {
    hooks.cursor = 0;
    hooks.effectCursor = 0;
    return namespace.useView(source, { ...query(), ra }, 0);
  };
  assert.equal(render(1).kind, "loading");
  assert.equal(render(2).kind, "loading");
  assert.equal(pending[0].signal.aborted, true);
  pending[1].request.resolve({ viewId: "new", manifest: {}, images: [], masks: [], fromCache: false });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(render(2).kind, "ready");
  pending[0].onProgress({ stage: "ready" });
  pending[0].request.resolve({ viewId: "old", manifest: {}, images: [], masks: [], fromCache: false });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(render(2).kind, "ready");
  assert.equal(render(2).view.viewId, "new");

  render(3);
  render(4);
  pending[3].request.resolve({ viewId: "latest", manifest: {}, images: [], masks: [], fromCache: false });
  await new Promise((resolve) => setImmediate(resolve));
  pending[2].request.reject(new Error("late old failure"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(render(4).view.viewId, "latest");
  render(5);
  pending[4].request.reject(null);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(render(5).kind, "error");
  assert.equal(render(5).code, "ERROR");
});


test("prebuilt manifest rejects malformed and mismatched queries before asset reads or registration", async () => {
  const requested = { ...query(), source: "auto", manifestUrl: "https://storage.invalid/a/manifest.json" };
  for (const actual of [undefined, null, {}, { ...requested, ra: 11 }, { ...requested, dec: 21 },
    { ...requested, ra: NaN }, { ...requested, fov_arcmin: 6 }, { ...requested, band: "B6" },
    { ...requested, ra: "10" }]) {
    const urls = [];
    let registered = false;
    const source = await loadApiSource({
      fetchAsset: async (url) => { urls.push(url); return { json: async () => ({ query: actual, epochs: [{ image: "wrong.f32" }] }) }; },
      createView: async () => { throw new Error("must not fall back to a build"); },
      registerGoldenView: () => { registered = true; },
    });
    await assert.rejects(source.load(requested, () => {}, new AbortController().signal), { code: "BAD_RESPONSE" });
    assert.deepEqual(urls, [requested.manifestUrl]);
    assert.equal(registered, false);
  }
});

test("matching prebuilt manifest accepts URL rounding and strips frontend-only measurement fields", async () => {
  let registered;
  const requested = { ...query(), source: "auto", manifestUrl: "https://storage.invalid/a/manifest.json" };
  const urls = [];
  const source = await loadApiSource({
    fetchAsset: async (url) => {
      urls.push(url);
      if (url.endsWith("manifest.json")) return { json: async () => ({ render_key: "prebuilt", query: { ...requested, ra: 10.000005 }, epochs: [{ image: "e.f32" }] }) };
      return responseForArrayBuffer(new Float32Array([4]).buffer);
    },
    createView: async () => { throw new Error("must not build a matching prebuilt view"); },
    registerGoldenView: (id, q) => { registered = { id, q }; },
  });
  const view = await source.load(requested, () => {}, new AbortController().signal);
  assert.equal(view.fromCache, true);
  assert.deepEqual([...view.images[0]], [4]);
  assert.deepEqual(urls, [requested.manifestUrl, "https://storage.invalid/a/e.f32"]);
  assert.equal(registered.id, "prebuilt");
  assert.equal("manifestUrl" in registered.q, false);
  assert.equal("presetId" in registered.q, false);
});

test("Saved and Live requests bypass an injected live prebuilt URL and strip it from backend requests", async () => {
  for (const mode of ["saved", "live"]) {
    const urls = [];
    let posted;
    const source = await loadApiSource({
      createView: async (q) => { posted = q; return { status: "ready", manifest_url: "/actual/manifest.json", view_id: "actual" }; },
      fetchAsset: async (url) => { urls.push(url); return { json: async () => ({ epochs: [] }) }; },
    });
    await source.load({ ...query(), source: mode, manifestUrl: "https://storage.invalid/live/manifest.json" }, () => {}, new AbortController().signal);
    assert.deepEqual(urls, ["/actual/manifest.json"]);
    assert.equal(posted.source, mode);
    assert.equal("manifestUrl" in posted, false);
    assert.equal("presetId" in posted, false);
  }
});

async function loadCatalogApi(fetch) {
  const { namespace } = await loadTypescriptModule("src/api.ts", {}, {
    "./lib/catalog": { validateCatalog: (value) => value },
  }, { fetch, AbortSignal, URLSearchParams });
  return namespace;
}

test("static measurements carry the displayed render key even when registration returns a newer query view", async () => {
  const urls = [];
  const api = await loadCatalogApi(async (url) => {
    urls.push(url);
    return { ok: true, json: async () => url === "/api/views"
      ? { view_id: "query-view", status: "ready", manifest_url: "/frames/new/manifest.json" }
      : { points: [] } };
  });
  const rendered = "a".repeat(24);
  api.registerGoldenView(rendered, { ra: 10, dec: 20, fov_arcmin: 2, band: "B1", source: "auto" });
  await api.getSpectrum(rendered, 1, 2, 0);
  await api.getLightCurve(rendered, 1, 2);
  await api.getGaiaMatch(rendered, 1, 2, 0);
  assert.equal(urls.filter((url) => url === "/api/views").length, 1);
  for (const url of urls.slice(1)) {
    assert.match(url, /^\/api\/views\/query-view\//);
    assert.equal(new URL(url, "https://example.test").searchParams.get("render_key"), rendered);
  }
});

test("dynamic view measurements stay tied to the displayed render when a watcher updates the query", async () => {
  const urls = [];
  const api = await loadCatalogApi(async (url) => {
    urls.push(url);
    return { ok: true, json: async () => ({ points: [] }) };
  });
  const displayed = "b".repeat(24);
  api.registerMeasurementRender("live-query", displayed);
  await api.getSpectrum("live-query", 1, 2, 0);
  await api.getLightCurve("live-query", 1, 2);
  await api.getGaiaMatch("live-query", 1, 2, 0);
  assert.equal(urls.length, 3);
  for (const url of urls) assert.equal(new URL(url, "https://example.test").searchParams.get("render_key"), displayed);
});

test("concurrent panels share one lazy registration and one cancellation does not interrupt the other", async () => {
  const registration = deferred();
  let posts = 0;
  let sharedSignal;
  const api = await loadCatalogApi(async (url, init) => {
    if (url === "/api/views") {
      posts += 1;
      sharedSignal = init.signal;
      return registration.promise;
    }
    return { ok: true, json: async () => ({ points: [] }) };
  });
  const rk = "c".repeat(24);
  api.registerGoldenView(rk, query());
  const leaving = new AbortController();
  const staying = new AbortController();
  const left = api.getGaiaMatch(rk, 1, 2, 0, leaving.signal);
  const leftRejected = assert.rejects(left, { name: "AbortError" });
  const right = api.getLightCurve(rk, 1, 2, staying.signal);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(posts, 1);
  leaving.abort();
  await leftRejected;
  assert.equal(sharedSignal.aborted, false);
  registration.resolve({ ok: true, json: async () => ({ view_id: "shared", status: "ready" }) });
  await right;
  assert.equal(posts, 1);
});

test("StrictMode-like abandoned setup sends no POST and the next setup registers once", async () => {
  let posts = 0;
  const api = await loadCatalogApi(async (url) => {
    if (url === "/api/views") posts += 1;
    return { ok: true, json: async () => url === "/api/views" ? { view_id: "new", status: "ready" } : { points: [] } };
  });
  const rk = "d".repeat(24);
  api.registerGoldenView(rk, query());
  const first = new AbortController();
  const abandoned = api.getSpectrum(rk, 1, 2, 0, first.signal);
  const rejected = assert.rejects(abandoned, { name: "AbortError" });
  first.abort();
  const next = api.getSpectrum(rk, 1, 2, 0, new AbortController().signal);
  await Promise.all([rejected, next]);
  assert.equal(posts, 1);
});

test("a lone abandoned setup never starts an unused POST", async () => {
  let posts = 0;
  const api = await loadCatalogApi(async () => {
    posts += 1;
    return { ok: true, json: async () => ({ view_id: "unused", status: "ready" }) };
  });
  const rk = "f".repeat(24);
  api.registerGoldenView(rk, query());
  const caller = new AbortController();
  const pending = api.getSpectrum(rk, 1, 2, 0, caller.signal);
  const rejected = assert.rejects(pending, { name: "AbortError" });
  caller.abort();
  await rejected;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(posts, 0);
});

test("all subscribers leaving aborts shared registration and permits a later retry", async () => {
  let posts = 0;
  let pendingSignal;
  const api = await loadCatalogApi(async (url, init) => {
    if (url !== "/api/views") return { ok: true, json: async () => ({ points: [] }) };
    posts += 1;
    if (posts === 1) {
      pendingSignal = init.signal;
      return new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }));
    }
    return { ok: true, json: async () => ({ view_id: "retry", status: "ready" }) };
  });
  const rk = "e".repeat(24);
  api.registerGoldenView(rk, query());
  const caller = new AbortController();
  const result = api.getSpectrum(rk, 1, 2, 0, caller.signal);
  const rejected = assert.rejects(result, { name: "AbortError" });
  await new Promise((resolve) => setImmediate(resolve));
  caller.abort();
  await rejected;
  assert.equal(pendingSignal.aborted, true);
  await api.getSpectrum(rk, 1, 2, 0);
  assert.equal(posts, 2);
});

test("direct coordinate catalog loading stays bundled while home remains Blob first with fallback", async () => {
  const calls = [];
  const api = await loadCatalogApi(async (url) => {
    calls.push(url);
    if (url.startsWith("https:")) return { ok: false };
    return { ok: true, json: async () => ({ version: "local" }) };
  });
  await api.getCatalog("points", undefined, false);
  assert.deepEqual(calls, ["/catalog/points.json"]);
  calls.length = 0;
  await api.getCatalog("points", undefined, true);
  assert.equal(calls.length, 2);
  assert.match(calls[0], /^https:/);
  assert.equal(calls[1], "/catalog/points.json");
});


test("exact default presets prefer golden snapshots before an unavailable prebuilt Blob URL", async () => {
  let registered;
  const requested = { ...query(), mode: "stack", source: "auto", presetId: "preset", manifestUrl: "https://storage.invalid/unavailable/manifest.json" };
  const preset = { id: "preset", ra: requested.ra, dec: requested.dec, fov: requested.fov_arcmin, band: requested.band };
  const calls = [];
  const source = await loadApiSource({
    findPreset: () => preset,
    createView: async () => { throw new Error("must not build"); },
    fetchAsset: async () => { throw new Error("must not fetch Blob"); },
    registerGoldenView: (id, q) => { registered = { id, q }; },
  }, { fetch: async (url) => {
    calls.push(url);
    return { ok: true, headers: { get: () => "application/json" }, json: async () => ({ render_key: "golden", epochs: [] }) };
  } });
  const result = await source.load(requested, () => {}, new AbortController().signal);
  assert.equal(result.cacheLayer, "snapshot");
  assert.deepEqual(calls, ["/golden/preset/manifest.json"]);
  assert.equal(registered.q.source, "saved");
});


test("Gaia abort rejects promptly while an image request is still pending", async () => {
  const gaia = deferred();
  const image = deferred();
  const source = await loadApiSource({
    fetchAsset: async (url) => {
      if (url.endsWith("manifest.json")) return { json: async () => ({ render_key: "r", extras: { gaia: "gaia.json" }, epochs: [{ image: "e.f32" }] }) };
      if (url.endsWith("gaia.json")) return gaia.promise;
      return image.promise;
    },
  });
  const load = source.load(query(), () => {}, new AbortController().signal);
  const rejected = assert.rejects(load, { name: "AbortError" });
  await new Promise((resolve) => setTimeout(resolve, 225));
  gaia.reject(new DOMException("aborted", "AbortError"));
  // No image resolution is needed for a failed/aborted Gaia request to reject.
  await rejected;
  image.resolve(responseForArrayBuffer(new Float32Array([1]).buffer));
});
