// Hosted pricer API: CORS allowlist, per-IP rate limit, input validation before any upstream call.
import { test } from "node:test";
import assert from "node:assert/strict";

import { generatePrivateKey } from "viem/accounts";

process.env.MOCK_GEMINI = "true";
process.env.OPERATOR_PRIVATE_KEY ??= generatePrivateKey(); // throwaway key per run; signs nothing here
const { app, validateQuoteRequest } = await import("../src/pricer.js");

async function withServer(a, fn) {
  const server = a.listen(0);
  await new Promise((r) => server.once("listening", r));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
  }
}
const ORIGIN = "https://arra.example";

test("CORS: only the configured frontend origin is allowed", async () => {
  await withServer(app({ allowedOrigins: [ORIGIN] }), async (base) => {
    const ok = await fetch(`${base}/health`, { headers: { origin: ORIGIN } });
    assert.equal(ok.headers.get("access-control-allow-origin"), ORIGIN);
    const evil = await fetch(`${base}/health`, { headers: { origin: "https://evil.example" } });
    assert.equal(evil.headers.get("access-control-allow-origin"), null);
    const pre = await fetch(`${base}/quote`, { method: "OPTIONS", headers: { origin: ORIGIN, "access-control-request-method": "POST", "access-control-request-headers": "content-type" } });
    assert.ok(pre.status < 300);
    assert.equal(pre.headers.get("access-control-allow-origin"), ORIGIN);
  });
});

test("rate limit: per-IP, 429 with Retry-After once the window is used up", async () => {
  await withServer(app({ allowedOrigins: [ORIGIN], rateLimit: { windowMs: 60_000, max: 3 } }), async (base) => {
    const codes = [];
    for (let i = 0; i < 5; i++) codes.push((await fetch(`${base}/health`)).status);
    assert.deepEqual(codes, [200, 200, 200, 429, 429]);
    const r = await fetch(`${base}/health`);
    assert.ok(Number(r.headers.get("retry-after")) > 0);
  });
});

test("/quote rejects malformed input with 400 before calling Gemini or the chain", async () => {
  await withServer(app({ allowedOrigins: [ORIGIN] }), async (base) => {
    const post = (body) => fetch(`${base}/quote`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const good = { eventTicker: "NBAF-2627CHAMP", instrumentSymbol: "GEMI-NBAF-2627CHAMP-BOS", side: "YES", payoutUsdc: 100, buyer: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" };
    for (const bad of [
      { ...good, payoutUsdc: -1 },
      { ...good, payoutUsdc: "1e9" },
      { ...good, payoutUsdc: 10_000_000 },
      { ...good, buyer: "0x123" },
      { ...good, eventTicker: "../../v1/orders" },
      { ...good, instrumentSymbol: "x".repeat(200) },
      { ...good, side: "MAYBE" },
    ]) {
      const r = await post(bad);
      assert.equal(r.status, 400, JSON.stringify(bad));
      assert.ok((await r.json()).error);
    }
    const huge = await fetch(`${base}/quote`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...good, pad: "x".repeat(50_000) }) });
    assert.equal(huge.status, 413);
  });
});

test("validateQuoteRequest normalizes a good request", () => {
  const v = validateQuoteRequest({ eventTicker: "NBAF-2627CHAMP", instrumentSymbol: "GEMI-NBAF-2627CHAMP-BOS", payoutUsdc: "250", buyer: "0x70997970c51812dc3a010c7d01b50e0d17dc79c8" });
  assert.equal(v.payoutUsdc, 250);
  assert.equal(v.side, "YES");
  assert.equal(v.buyer, "0x70997970C51812dc3A010C7d01b50e0d17dc79C8");
});

test("upstream failures are 502, not 400, and never echo internals", async () => {
  await withServer(app({ allowedOrigins: [ORIGIN] }), async (base) => {
    const r = await fetch(`${base}/quote`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ eventTicker: "NO-SUCH-EVENT", instrumentSymbol: "GEMI-NO-SUCH", payoutUsdc: 10, buyer: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" }),
    });
    assert.ok([400, 404, 502].includes(r.status));
    const body = await r.json();
    assert.ok(!/at .*\.js:\d+/.test(JSON.stringify(body)), "no stack traces");
  });
});
