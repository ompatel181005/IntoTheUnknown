import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../src/lib/catalogSort.ts", import.meta.url), "utf8");
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { catalogCounts, sortCatalogItems, formatDataCounts } = await import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`);
const url = "https://example.test/r/exact-key/manifest.json";
const object = { id: "Target", view: { manifest_url: url, passes: 2 } };
const availability = { schema: 1, objects: { Target: { manifest_url: url, render_key: "exact-key", frames: 148, passes: 4, bands: 6 } } };
const item = (id, frames, passes, name = id) => ({ id, name, counts: { frames, passes, bands: null } });

test("counts require exact immutable manifest URL, render key and case-sensitive ID", () => {
  assert.deepEqual(catalogCounts(object, availability), { frames: 148, passes: 4, bands: 6 });
  for (const changed of [
    { ...object, id: "target" },
    { ...object, view: { ...object.view, manifest_url: "https://other.test/r/exact-key/manifest.json" } },
    { ...object, view: { ...object.view, manifest_url: "https://example.test/query/manifest.json" } },
  ]) assert.deepEqual(catalogCounts(changed, availability), { frames: null, passes: 2, bands: null });
  const mismatchedKey = structuredClone(availability);
  mismatchedKey.objects.Target.render_key = "stale-key";
  assert.equal(catalogCounts(object, mismatchedKey).frames, null);
  assert.equal(catalogCounts(object, { ...availability, schema: 2 }).frames, null);
});

test("missing and invalid counts remain unknown, and known zero remains zero", () => {
  const metadata = structuredClone(availability);
  Object.assign(metadata.objects.Target, { frames: 0, passes: -1, bands: 1.5 });
  assert.deepEqual(catalogCounts(object, metadata), { frames: 0, passes: null, bands: null });
  assert.deepEqual(catalogCounts({ id: "missing" }, availability), { frames: null, passes: null, bands: null });
  assert.equal(formatDataCounts({ frames: null, passes: 0, bands: 6 }), "? frames · 0 passes · 6 bands");
});

test("most frames defaults to descending quantity, pass ties, name ties and unknown last", () => {
  const items = [item("unknown", null, 99), item("zero", 0, 0), item("beta", 10, 2), item("alpha", 10, 2), item("more-passes", 10, 3), item("most", 20, 1)];
  const original = items.map((row) => row.id);
  assert.deepEqual(sortCatalogItems(items, "frames").map((row) => row.id), ["most", "more-passes", "alpha", "beta", "zero", "unknown"]);
  assert.deepEqual(items.map((row) => row.id), original);
});

test("passes and names sort deterministically without altering checked target identity", () => {
  const items = [item("c", 100, null, "Crab"), item("a", 2, 4, "Alpha"), item("b", 1, 4, "Beta"), item("z", 0, 0, "Zero")];
  const checked = new Set(["b", "c"]);
  const sorted = sortCatalogItems(items, "passes");
  assert.deepEqual(sorted.map((row) => row.id), ["a", "b", "z", "c"]);
  assert.deepEqual(sortCatalogItems(items, "name").map((row) => row.id), ["a", "b", "c", "z"]);
  assert.deepEqual(sorted.filter((row) => checked.has(row.id)).map((row) => row.id), ["b", "c"]);
});
