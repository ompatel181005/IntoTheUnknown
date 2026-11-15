// Run from frontend/: node --test tests/gaia.test.mjs
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const read = (rel) => readFile(new URL(rel, import.meta.url), "utf8");
const js = ts.transpileModule(await read("../src/lib/gaia.ts"), { compilerOptions: { module: "ESNext", target: "ES2022" } }).outputText;
const { gaiaMarks, ARROW_GAIN } = await import(`data:text/javascript,${encodeURIComponent(js)}`);

test("Barnard's Star: one arrow, undetected catalogue stars skipped, y flipped", async () => {
  const gaia = JSON.parse(await read("../public/golden/barnard/gaia.json"));
  const ny = 59;
  const marks = gaiaMarks(gaia, 0, ny);
  assert.ok(marks.length > 0 && marks.length < gaia.stars.length / 4, `${marks.length} of ${gaia.stars.length} drawn`);

  const arrows = marks.filter((m) => m.arrow);
  assert.equal(arrows.length, 1);
  const star = gaia.stars.find((s) => s.pmdec > 10000);
  const [fx, fy] = star.track_px[0];
  const [lx, ly] = star.track_px.at(-1);
  const [x1, y1, x2, y2] = arrows[0].arrow;
  assert.deepEqual([x1, y1], [fx + 0.5, ny - fy - 0.5]);
  assert.ok(Math.abs(x2 - x1 - (lx - fx) * ARROW_GAIN) < 1e-9);
  assert.ok(Math.abs(y2 - y1 + (ly - fy) * ARROW_GAIN) < 1e-9); // north is up: +y on the grid is -y in SVG
  assert.ok(y2 < y1, "Barnard's Star moves north");

  assert.equal(gaiaMarks(gaia, 2, ny).find((m) => m.arrow).matched, false); // matched: [true, true, false]
  assert.deepEqual(gaiaMarks(gaia, 99, ny), []);
});
