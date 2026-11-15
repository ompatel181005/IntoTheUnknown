import assert from "node:assert/strict";
import test from "node:test";
import worker, { ORIGIN } from "../../infra/gateway/worker.mjs";

test("pins Azure, preserves POST body/query, strips platform credentials", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async (request, options) => {
      assert.equal(request.url, `${ORIGIN}/api/views?x=2`);
      assert.equal(request.method, "POST");
      assert.equal(await request.text(), '{"source":"saved"}');
      assert.equal(request.headers.get("content-type"), "application/json");
      for (const name of ["authorization", "cookie", "x-refresh-key", "host", "x-platform-user"])
        assert.equal(request.headers.has(name), false);
      assert.equal(options.redirect, "manual");
      return Response.json({ view_id: "v" }, { headers: { "set-cookie": "not-forwarded=1" } });
    };
    const response = await worker.fetch(new Request("https://space.omnp.me/api/views?x=2", {
      method: "POST", body: '{"source":"saved"}', headers: {
        "Content-Type": "application/json", "Authorization": "test-only", "Cookie": "test-only",
        "X-Refresh-Key": "test-only", "X-Platform-User": "test-only", "Host": "space.omnp.me",
      },
    }));
    assert.equal(response.status, 200);
    assert.equal(response.headers.has("set-cookie"), false);
  } finally { globalThis.fetch = original; }
});

test("streams exact binary data and preserves range/cache headers", async () => {
  const original = globalThis.fetch;
  try {
    const bytes = new Uint8Array([0, 255, 32, 18]);
    globalThis.fetch = async (request) => {
      assert.equal(request.headers.get("range"), "bytes=0-3");
      return new Response(bytes, { status: 206, headers: {
        "content-type": "application/octet-stream", "content-range": "bytes 0-3/8",
        "cache-control": "public, max-age=60",
      } });
    };
    const response = await worker.fetch(new Request("https://space.omnp.me/frames/r/x/e0.f32", { headers: { Range: "bytes=0-3" } }));
    assert.equal(response.status, 206);
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
    assert.equal(response.headers.get("content-range"), "bytes 0-3/8");
  } finally { globalThis.fetch = original; }
});

test("rewrites Azure redirects to the public hostname", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(null, { status: 307, headers: { location: `${ORIGIN}/golden/` } });
    const response = await worker.fetch(new Request("https://space.omnp.me/golden"));
    assert.equal(response.status, 307);
    assert.equal(response.headers.get("location"), "https://space.omnp.me/golden/");
  } finally { globalThis.fetch = original; }
});

test("preserves archive errors and safely handles transport failure", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => Response.json({ error: { code: "IRSA_DOWN" } }, { status: 503 });
    const error = await worker.fetch(new Request("https://space.omnp.me/api/views/v"));
    assert.equal((await error.json()).error.code, "IRSA_DOWN");
    globalThis.fetch = async () => { throw new Error("test-only details not exposed"); };
    const unavailable = await worker.fetch(new Request("https://space.omnp.me/api/views/v"));
    assert.equal(unavailable.status, 503);
    assert.equal((await unavailable.json()).error.code, "GATEWAY_UNAVAILABLE");
  } finally { globalThis.fetch = original; }
});
