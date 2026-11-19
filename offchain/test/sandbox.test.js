// Gemini SANDBOX trading, driven by real responses (fixtures/gemini-sandbox-orders.json,
// POST /v1/prediction-markets/order, captured 2026-11-19).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

process.env.MOCK_GEMINI = "false";
process.env.GEMINI_API_KEY ??= "account-test";
process.env.GEMINI_API_SECRET ??= "test-secret";
const { parseOrderResponse, signedHeaders, nextNonce, sandboxSymbolFor, eventTickerOf } = await import("../src/gemini.js");
const { filledContracts } = await import("../src/hedger.js");

const fx = JSON.parse(fs.readFileSync(new URL("./fixtures/gemini-sandbox-orders.json", import.meta.url), "utf8"));
const filled = fx.orders.find((o) => o.label === "filled");
const unfilled = fx.orders.find((o) => o.label === "unfilled");
const rawId = (raw) => raw.match(/"orderId":(\d+)/)[1];

test("orderId is a JSON number above 2^53: JSON.parse corrupts it, parseOrderResponse keeps it exact", () => {
  const id = rawId(filled.raw);
  assert.ok(BigInt(id) > BigInt(Number.MAX_SAFE_INTEGER));
  assert.notEqual(String(JSON.parse(filled.raw).orderId), id, "plain JSON.parse rounds the id");
  assert.equal(parseOrderResponse(filled.raw).orderId, id);
});

test("real IOC fill: filledQuantity is what Gemini executed; that is what gets recorded", () => {
  const o = parseOrderResponse(filled.raw);
  assert.equal(o.status, "filled");
  assert.equal(filledContracts(o, 5), 5);
  assert.equal(o.avgExecutionPrice, "0.5");
});

test("real IOC with no match: status cancelled, filledQuantity 0 -> nothing recorded", () => {
  const o = parseOrderResponse(unfilled.raw);
  assert.equal(o.status, "cancelled");
  assert.equal(filledContracts(o, 5), 0);
});

test("order request matches the shape the sandbox accepted", () => {
  for (const k of ["symbol", "orderType", "side", "outcome", "quantity", "price", "timeInForce"]) assert.ok(k in filled.request, k);
  assert.equal(filled.request.timeInForce, "immediate-or-cancel");
});

test("nonce: a JSON number, in seconds (sandbox: 'within 30 seconds of server time'), strictly increasing", () => {
  const t = Date.parse("2026-11-19T07:57:15Z");
  const a = nextNonce(t);
  const b = nextNonce(t);
  assert.equal(a, Math.floor(t / 1000));
  assert.ok(b > a);
  const h = signedHeaders("/v1/x", {});
  const payload = JSON.parse(Buffer.from(h["X-GEMINI-PAYLOAD"], "base64").toString());
  assert.equal(typeof payload.nonce, "number");
  assert.ok(Math.abs(payload.nonce - Date.now() / 1000) < 60);
});

test("sandbox has no sports: SANDBOX_SYMBOL_MAP routes a production contract to a sandbox stand-in", () => {
  const map = { "GEMI-NHL-2611200000-PHI-OTT-M-PHI": "GEMI-BTC2611192200-HI62500" };
  assert.equal(sandboxSymbolFor("GEMI-NHL-2611200000-PHI-OTT-M-PHI", map), "GEMI-BTC2611192200-HI62500");
  assert.equal(sandboxSymbolFor("GEMI-OTHER", map), "GEMI-OTHER"); // unmapped: same symbol
  assert.equal(eventTickerOf("GEMI-BTC2611192200-HI62500"), "BTC2611192200");
  assert.equal(eventTickerOf("GEMI-NHL-2611200000-PHI-OTT-M-PHI"), "NHL-2611200000-PHI-OTT-M");
});
