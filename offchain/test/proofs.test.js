// Automatic public proofs: every settled event re-checked from chain + attested bytes + live Gemini.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { keccak256 } from "viem";

process.env.MOCK_GEMINI = "false";
const { proveEvent } = await import("../src/proofs.js");

const ml = JSON.parse(fs.readFileSync(new URL("./fixtures/gemini-events-moneyline.json", import.meta.url), "utf8")).data[0];
const settled = (winnerSuffix, extra = {}) => {
  const { events, ...e } = structuredClone(ml);
  return { ...extra, ...e, status: "settled", contracts: e.contracts.map((c) => ({ ...c, status: "settled", marketState: "closed", resolutionSide: c.instrumentSymbol.endsWith(winnerSuffix) ? "yes" : "no" })) };
};
const bytesOf = (ev) => new TextEncoder().encode(JSON.stringify({ data: ev }));
const winnerIndex = (ev, suffix) => [...ev.contracts].sort((a, b) => (a.instrumentSymbol < b.instrumentSymbol ? -1 : 1)).findIndex((c) => c.instrumentSymbol.endsWith(suffix));
const base = (bytes, w) => ({ eventTicker: ml.ticker, onchain: { state: "Settled", winningOutcome: w, evidenceHash: keccak256(bytes) } });

test("real settlement: evidence checks out and Gemini's live result agrees -> PASS", async () => {
  const ev = settled("-ARI");
  const bytes = bytesOf(ev);
  const r = await proveEvent({ ...base(bytes, winnerIndex(ev, "-ARI")), loadBytes: async () => bytes, getLive: async () => settled("-ARI") });
  assert.equal(r.verdict, "PASS");
  assert.equal(r.live, "agrees");
  assert.equal(r.synthetic, false);
});

test("real settlement where Gemini now says otherwise -> FAIL", async () => {
  const ev = settled("-ARI");
  const bytes = bytesOf(ev);
  const r = await proveEvent({ ...base(bytes, winnerIndex(ev, "-ARI")), loadBytes: async () => bytes, getLive: async () => settled("-SF") });
  assert.equal(r.verdict, "FAIL");
  assert.equal(r.live, "disagrees");
});

test("synthetic testnet settlement (marked in its evidence) is labelled, not failed, while Gemini hasn't settled", async () => {
  const ev = settled("-ARI", { _arraSynthetic: "testnet demo" });
  const bytes = bytesOf(ev);
  const open = structuredClone(ml);
  const r = await proveEvent({ ...base(bytes, winnerIndex(ev, "-ARI")), loadBytes: async () => bytes, getLive: async () => open });
  assert.equal(r.synthetic, true);
  assert.equal(r.verdict, "SYNTHETIC");
  assert.equal(r.evidence, "ok");
});

test("missing or tampered evidence -> FAIL, whatever Gemini says", async () => {
  const ev = settled("-ARI");
  const bytes = bytesOf(ev);
  const r1 = await proveEvent({ ...base(bytes, winnerIndex(ev, "-ARI")), loadBytes: async () => null, getLive: async () => ev });
  assert.equal(r1.verdict, "FAIL");
  assert.equal(r1.evidence, "missing");
  const r2 = await proveEvent({ ...base(bytes, winnerIndex(ev, "-ARI")), loadBytes: async () => bytesOf(settled("-SF")), getLive: async () => ev });
  assert.equal(r2.verdict, "FAIL");
});

test("open events are PENDING; Gemini being unreachable never turns a good proof into a pass or a fail", async () => {
  const r = await proveEvent({ eventTicker: ml.ticker, onchain: { state: "Open" }, loadBytes: async () => null, getLive: async () => ml });
  assert.equal(r.verdict, "PENDING");
  const ev = settled("-ARI");
  const bytes = bytesOf(ev);
  const r2 = await proveEvent({ ...base(bytes, winnerIndex(ev, "-ARI")), loadBytes: async () => bytes, getLive: async () => { throw new Error("down"); } });
  assert.equal(r2.verdict, "UNCHECKED");
  assert.equal(r2.evidence, "ok");
});

test("a synthetic settlement that Gemini later contradicts stays SYNTHETIC (it never claimed the real result)", async () => {
  const ev = settled("-ARI", { _arraSynthetic: "testnet demo" });
  const bytes = bytesOf(ev);
  const r = await proveEvent({ ...base(bytes, winnerIndex(ev, "-ARI")), loadBytes: async () => bytes, getLive: async () => settled("-SF") });
  assert.equal(r.verdict, "SYNTHETIC");
  assert.equal(r.live, "disagrees");
});
