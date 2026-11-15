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
  const javascript = ts.transpileModule(source, {
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
      registerGoldenView: () => {},
    },
    "../lib/targets": { findPreset: () => null },
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
  await new Promise((resolve) => setImmediate(resolve));
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
  await new Promise((resolve) => setImmediate(resolve));
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

test("queued wait abort cleans up its listener and does not poll", async () => {
  let polls = 0;
  const source = await loadApiSource({
    createView: async () => ({ status: "queued", status_url: "/status", view_id: "v" }),
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
  assert.deepEqual(delays, [350, 1500]);
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
