// Regression tests for the independent verification pass (docs/REVIEW.md, section "Verifier findings").
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { keccak256 } from "viem";

process.env.MOCK_GEMINI = "false";
const { createDepthStore } = await import("../src/depth.js");
const { verifyEvidence } = await import("../src/verify.js");
const { riskAfterTrade } = await import("../src/pricing.js");
const { salesWindow } = await import("../src/pricer.js");
const { settledOutcome, votesToCast, VOID_OUTCOME } = await import("../src/settler.js");
const { outcomeIndex, hedgeTarget, getBook, executablePrice } = await import("../src/gemini.js");
const { snapshotOutcomes } = await import("../src/registry.js");

// ---------------------------------------------------------------- depth: snapshot frames only

test("N-4: after a gap, in-flight deltas (U < u) cannot pose as the new snapshot; only U == u starts a book", () => {
  const store = createDepthStore();
  assert.equal(store.onFrame({ e: "depthUpdate", s: "gemi-x", U: 10, u: 10, b: [], a: [["0.45", "50"], ["0.50", "70"]] }), "snapshot");
  assert.equal(store.onFrame({ e: "depthUpdate", s: "gemi-x", U: 20, u: 25, b: [], a: [] }), "gap");
  assert.equal(store.onFrame({ e: "depthUpdate", s: "gemi-x", U: 25, u: 30, b: [], a: [["0.45", "5"]] }), "awaiting-snapshot");
  assert.equal(store.getDepthBook("gemi-x"), null);
  assert.equal(store.onFrame({ e: "depthUpdate", s: "gemi-x", U: 31, u: 31, b: [], a: [["0.44", "9"]] }), "snapshot");
  assert.deepEqual(store.getDepthBook("gemi-x").asks, [{ price: 0.44, qty: 9 }]);
});

// ---------------------------------------------------------------- verifier: right event

const settledEvent = (ticker) => ({
  ticker,
  sportsMarket: { type: "moneyline" },
  contracts: [
    { instrumentSymbol: `GEMI-${ticker}-A`, status: "settled", resolutionSide: "yes" },
    { instrumentSymbol: `GEMI-${ticker}-B`, status: "settled", resolutionSide: "no" },
  ],
});

test("N-6: evidence for another event fails, even when it implies the same outcome index", () => {
  const other = new TextEncoder().encode(JSON.stringify({ data: settledEvent("NHL-OTHER-M") }));
  const r = verifyEvidence({ bytes: other, eventTicker: "NHL-THIS-M", onchain: { state: "Settled", evidenceHash: keccak256(other), winningOutcome: 0 } });
  assert.equal(r.pass, false);
  assert.equal(r.checks.find((c) => c.name === "evidence is for this event").ok, false);
  const mine = new TextEncoder().encode(JSON.stringify({ data: settledEvent("NHL-THIS-M") }));
  assert.equal(verifyEvidence({ bytes: mine, eventTicker: "NHL-THIS-M", onchain: { state: "Settled", evidenceHash: keccak256(mine), winningOutcome: 0 } }).pass, true);
});

// ---------------------------------------------------------------- outcome order pinned at first sale

const futures = (symbols) => ({
  ticker: "NHLCHAMP27",
  title: "Pro Hockey Champion",
  type: "categorical",
  eventTags: [{ slug: "futures" }],
  contracts: symbols.map((s) => ({ instrumentSymbol: s, status: "active", marketState: "open", prices: {} })),
});

test("N-3: a contract added after the first sale does not shift existing outcome indexes", () => {
  const before = futures(["GEMI-NHLCHAMP27-BOS", "GEMI-NHLCHAMP27-TOR"]);
  const pinned = snapshotOutcomes(before); // what the registry stores at first sale
  // Gemini lists a new team that sorts first: live sorted order now shifts every index by one.
  const after = futures(["GEMI-NHLCHAMP27-ANA", "GEMI-NHLCHAMP27-BOS", "GEMI-NHLCHAMP27-TOR"]);
  assert.equal(outcomeIndex(after, "GEMI-NHLCHAMP27-TOR", "YES"), 2, "unpinned: TOR moved from 1 to 2");
  assert.equal(outcomeIndex(after, "GEMI-NHLCHAMP27-TOR", "YES", pinned), 1);
  assert.equal(outcomeIndex(after, "GEMI-NHLCHAMP27-ANA", "YES", pinned), 2, "new contracts get the next free index");
  assert.equal(hedgeTarget(after, 1, pinned).instrumentSymbol, "GEMI-NHLCHAMP27-TOR");
  const settled = futures(["GEMI-NHLCHAMP27-ANA", "GEMI-NHLCHAMP27-BOS", "GEMI-NHLCHAMP27-TOR"]);
  settled.contracts.forEach((c) => Object.assign(c, { status: "settled", resolutionSide: c.instrumentSymbol.endsWith("TOR") ? "yes" : "no" }));
  assert.equal(settledOutcome(settled, pinned), 1);
});

test("N-3: a pinned contract that disappeared from the event blocks settlement (a human must look)", () => {
  const pinned = ["GEMI-NHLCHAMP27-BOS", "GEMI-NHLCHAMP27-TOR"];
  const ev = futures(["GEMI-NHLCHAMP27-TOR"]);
  ev.contracts[0].status = "settled";
  ev.contracts[0].resolutionSide = "yes";
  assert.equal(settledOutcome(ev, pinned), null);
});

// ---------------------------------------------------------------- pricer collateral mirror

test("N-7: the pricer's locked mirror includes premiums (vault locks max(max_i L_i, premiums))", () => {
  const r = riskAfterTrade({ liab: [1000, 1000, 1000, 1000], hedged: [0, 0, 0, 0], premiums: 1600, totalAssets: 100_000, capBps: 10_000, outcome: 0, payout: 500 });
  assert.equal(r.lockedAfter, 1600);
  assert.equal(r.deltaLocked, 0);
});

// ---------------------------------------------------------------- tighter in-game windows

test("H-3 residual: in-game windows end well inside a regulation game", () => {
  const ev = (sport) => ({ ticker: "X", startTime: "2026-11-19T00:00:00Z", sportsMarket: { sport } });
  const start = Date.parse("2026-11-19T00:00:00Z") / 1000;
  assert.equal(salesWindow(ev("basketball"), start + 3600).mode, "in-game"); // halftime comeback
  assert.throws(() => salesWindow(ev("basketball"), start + 100 * 60), /over/); // ~a college game's length
  assert.throws(() => salesWindow(ev("baseball"), start + 160 * 60), /over/);
  assert.throws(() => salesWindow(ev("soccer"), start + 100 * 60), /over/);
});

// ---------------------------------------------------------------- automatic VOID keeps the veto window

test("N-8: an automatic VOID vote stops at the threshold, so the guardian always gets a dispute window", () => {
  assert.equal(votesToCast({ outcome: VOID_OUTCOME, threshold: 2, wallets: 3 }), 2);
  assert.equal(votesToCast({ outcome: 4, threshold: 2, wallets: 3 }), 3);
});

// ---------------------------------------------------------------- modeled fallback sized to real books

test("M-5 residual: without live depth, the modeled ladder is sized to real books (tens to hundreds of contracts)", () => {
  const c = { instrumentSymbol: "GEMI-X-A", prices: { bestAsk: "0.13", bestBid: "0.07" } };
  const fill = executablePrice(getBook({ contracts: [c] }, c, () => null), "YES", 5000);
  assert.ok(fill.filled <= 1000, `modeled ladder still offers ${fill.filled} contracts`);
});

// ---------------------------------------------------------------- listing pages through everything

test("listActiveEvents pages through results (a 50-per-query cap hid live games from the settler)", async () => {
  const { listActiveEvents } = await import("../src/gemini.js");
  const all = [...Array(130).keys()].map((i) => ({ ticker: `NFL-G${i}-M`, sportsMarket: { type: "moneyline" }, contracts: [] }));
  const orig = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    const isMoneyline = u.searchParams.get("sports_market_type") === "moneyline";
    const offset = Number(u.searchParams.get("offset") ?? 0);
    const limit = Number(u.searchParams.get("limit"));
    const data = isMoneyline ? all.slice(offset, offset + limit) : [];
    return new Response(JSON.stringify({ data, pagination: { limit, offset, total: isMoneyline ? all.length : 0 } }), { status: 200 });
  };
  try {
    const events = await listActiveEvents({ maxPages: 10 });
    assert.equal(events.filter((e) => e.ticker.startsWith("NFL-G")).length, 130);
    assert.equal((await listActiveEvents()).filter((e) => e.ticker.startsWith("NFL-G")).length, 50, "the public list stays one page");
  } finally {
    globalThis.fetch = orig;
  }
});
