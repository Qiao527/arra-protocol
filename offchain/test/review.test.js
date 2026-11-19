// Regression tests for the independent review (docs/REVIEW.md). Each test names its finding.
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.MOCK_GEMINI = "false";
const { settledOutcome, checkVoteOutcome, VOID_OUTCOME } = await import("../src/settler.js");
const { computePremium, premiumUnits } = await import("../src/pricing.js");
const { webhookApp, serializeByKey, filledContracts } = await import("../src/hedger.js");

const c = (sym, extra = {}) => ({ instrumentSymbol: sym, label: sym, status: "active", marketState: "open", prices: {}, ...extra });
const settled = (sym, side) => c(sym, { status: "settled", marketState: "closed", resolutionSide: side });
const champ = (n, winner) => ({
  ticker: "NCAAM-2627CHAMP",
  title: "NCAA Men's Basketball Champion",
  type: "categorical",
  eventTags: [{ slug: "futures" }],
  contracts: [...Array(n).keys()].map((i) => settled(`GEMI-NCAAM-T${String(i).padStart(3, "0")}`, i === winner ? "yes" : "no")),
});

// ---------------------------------------------------------------- settler

test("H-2: settler can vote any real championship index (vault allows < 128), not just 0..15", () => {
  const ev = champ(94, 57);
  const o = settledOutcome(ev);
  assert.equal(o, 57);
  assert.equal(checkVoteOutcome(o), 57);
  assert.equal(checkVoteOutcome(127), 127);
  assert.throws(() => checkVoteOutcome(128), /bad outcome/);
  assert.throws(() => checkVoteOutcome(-1), /bad outcome/);
  assert.throws(() => checkVoteOutcome(1.5), /bad outcome/);
  assert.equal(checkVoteOutcome(VOID_OUTCOME), 255);
});

test("M-4: two contracts both resolving YES is ambiguous evidence: refuse to vote", () => {
  const ev = { sportsMarket: { type: "moneyline" }, contracts: [settled("GEMI-A", "yes"), settled("GEMI-B", "yes")] };
  assert.equal(settledOutcome(ev), null);
});

test("void: a settled moneyline with no winning contract (tie, no draw contract) votes VOID", () => {
  const ev = { sportsMarket: { type: "moneyline" }, contracts: [settled("GEMI-DAL", "no"), settled("GEMI-PHI", "no")] };
  assert.equal(settledOutcome(ev), VOID_OUTCOME);
});

test("partially settled event (some contracts still active) never settles", () => {
  const ev = champ(30, 3);
  ev.contracts[10] = c(ev.contracts[10].instrumentSymbol);
  assert.equal(settledOutcome(ev), null);
});

test("single-contract binary event: all-NO is a normal NO, not a void", () => {
  assert.equal(settledOutcome({ contracts: [settled("GEMI-X", "no")] }), 1);
});

// ---------------------------------------------------------------- pricing

test("L-1: premium is rounded UP to the USDC unit from the exact value, never to the nearest cent first", () => {
  // exact premium = 1 * 0.0999 * 1.05 = 0.104895 USDC; rounding to cents first gave 0.10.
  const b = computePremium({ payoutUsdc: 1, pExec: 0.0999, hedgeBufferBps: 500, capitalChargeBps: 0 });
  assert.ok(premiumUnits(b) >= 104_895n, `premium ${premiumUnits(b)} < exact 104895`);
  assert.ok(premiumUnits(b) <= 104_896n);
});

// ---------------------------------------------------------------- hedger webhook

const log = (txHash, logIndex) => ({ transactionHash: txHash, logIndex, topics: ["0x00"], data: "0x" });

async function withServer(app, fn) {
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const url = `http://127.0.0.1:${server.address().port}/quicknode`;
  try {
    return await fn(url);
  } finally {
    server.close();
  }
}
const post = (url, body, secret) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json", ...(secret ? { "x-arra-secret": secret } : {}) }, body: JSON.stringify(body) });

test("M-3: webhook fails closed without a configured secret, and rejects a wrong one", async () => {
  const seen = [];
  await withServer(webhookApp({ secret: undefined, onLog: async (l) => seen.push(l) }), async (url) => {
    assert.equal((await post(url, { logs: [log("0x1", 0)] })).status, 503);
  });
  await withServer(webhookApp({ secret: "s3cret", onLog: async (l) => seen.push(l) }), async (url) => {
    assert.equal((await post(url, { logs: [log("0x1", 0)] }, "wrong")).status, 401);
    assert.equal((await post(url, { logs: [log("0x1", 0)] })).status, 401);
  });
  assert.equal(seen.length, 0);
});

test("M-3: a log delivered twice (QuickNode retry) is processed once", async () => {
  const seen = [];
  await withServer(webhookApp({ secret: "s3cret", onLog: async (l) => seen.push(l.transactionHash) }), async (url) => {
    assert.equal((await post(url, { logs: [log("0xaa", 1)] }, "s3cret")).status, 200);
    assert.equal((await post(url, { logs: [log("0xaa", 1), log("0xbb", 0)] }, "s3cret")).status, 200);
    await new Promise((r) => setTimeout(r, 50));
  });
  assert.deepEqual(seen, ["0xaa", "0xbb"]);
});

test("M-3: hedges for the same event never run concurrently (no double Gemini order)", async () => {
  const run = serializeByKey();
  let active = 0;
  let maxActive = 0;
  const job = () =>
    run("event-1", async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 20));
      active--;
    });
  await Promise.all([job(), job(), job()]);
  assert.equal(maxActive, 1);
});

test("M-2: record only what Gemini filled; an unknown response shape records nothing", () => {
  assert.equal(filledContracts({ orderId: "1", quantity: "3000", status: "open" }), 0);
  assert.equal(filledContracts({ orderId: "1", quantity: "3000", filledQuantity: "1200" }), 1200);
  assert.equal(filledContracts({ orderId: "1", quantity: "3000", filledQuantity: "9000" }, 3000), 3000); // never above requested
});

// ---------------------------------------------------------------- live stale in-game markets (H-3)
// Captured from the live API on 2026-11-19: both games were over, yet Gemini still listed every
// contract open with isLive: true (ULL-UNCW 103 h after tip-off).
import fs from "node:fs";
const stale = JSON.parse(fs.readFileSync(new URL("./fixtures/gemini-events-stale-ingame.json", import.meta.url), "utf8"));
const at = Math.floor(Date.parse(stale.capturedAt) / 1000);
const [ullUncw, hawWsu] = stale.events;
const { salesWindow } = await import("../src/pricer.js");
const { getBook, executablePrice } = await import("../src/gemini.js");

test("H-3: no in-game cover once the game is surely over, even though Gemini still says open/isLive", () => {
  assert.equal(ullUncw.isLive, true);
  assert.ok(ullUncw.contracts.every((k) => k.marketState === "open"));
  assert.throws(() => salesWindow(ullUncw, at), /over/); // 103 h after tip-off
  assert.throws(() => salesWindow(hawWsu, at), /over/); // 4.5 h after tip-off, college basketball
  const start = Math.floor(Date.parse(hawWsu.startTime) / 1000);
  assert.equal(salesWindow(hawWsu, start + 3600).mode, "in-game"); // second half is still sellable
});

test("H-3: buy/sell are display prices; without a bestAsk there is no seller, so no YES book", () => {
  const wsu = hawWsu.contracts.find((k) => k.instrumentSymbol.endsWith("-WSU"));
  assert.equal(wsu.prices.bestAsk, undefined);
  assert.equal(wsu.prices.buy.yes, wsu.prices.bestBid); // buy.yes falls back to the BID
  const book = getBook(hawWsu, wsu);
  assert.equal(book.asks.length, 0);
  assert.equal(executablePrice(book, "YES", 5000).filled, 0);

  const haw = hawWsu.contracts.find((k) => k.instrumentSymbol.endsWith("-HAW"));
  assert.equal(haw.prices.bestBid, undefined);
  assert.equal(getBook(hawWsu, haw).bids.length, 0); // 1 - buy.no is the ASK here, not a bid
  assert.equal(getBook(hawWsu, haw).asks[0].price, Number(haw.prices.bestAsk));
});
