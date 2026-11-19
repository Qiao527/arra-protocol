// Unit tests for the Gemini adapter against a real API response (trimmed fixture) and
// synthetic moneyline / binary events. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

process.env.MOCK_GEMINI = "false";
const { getBook, executablePrice, isMutuallyExclusive, orderedContracts, outcomeIndex, hedgeTarget } = await import("../src/gemini.js");
const { settledOutcome, contractSide } = await import("../src/settler.js");

const real = JSON.parse(fs.readFileSync(new URL("./fixtures/gemini-events-props.json", import.meta.url), "utf8"));
const props = real.data[0];

const moneyline = (contracts) => ({
  ticker: "GEMI-NFL-2611221800-DAL-PHI-M",
  sportsMarket: { sport: "american_football", type: "moneyline", subject: "contest", scope: { type: "full_contest" } },
  contracts,
});
const c = (sym, extra = {}) => ({ instrumentSymbol: sym, label: sym, status: "active", marketState: "open", prices: {}, ...extra });

test("real list response: data[] + pagination, events carry startTime and sportsMarket", () => {
  assert.ok(Array.isArray(real.data));
  assert.equal(typeof real.pagination.total, "number");
  assert.ok(!Number.isNaN(Date.parse(props.startTime)));
  assert.equal(props.sportsMarket.type, "prop");
});

test("player props are NOT mutually exclusive: no netting, no cover", () => {
  assert.equal(isMutuallyExclusive(props), false);
  const sym = props.contracts.find((x) => x.status === "active").instrumentSymbol;
  assert.throws(() => outcomeIndex(props, sym, "YES"), /not mutually exclusive/);
});

test("empty prices ({buy:{}, sell:{}}) give an empty book, so no quote", () => {
  const contract = props.contracts.find((x) => x.status === "active");
  assert.deepEqual(contract.prices, { buy: {}, sell: {} });
  const book = getBook(props, contract);
  assert.equal(book.asks.length, 0);
  assert.equal(executablePrice(book, "YES", 100).filled, 0);
});

test("real settled contract: status settled + resolutionSide", () => {
  const settled = props.contracts.find((x) => x.status === "settled");
  assert.ok(["YES", "NO"].includes(contractSide(settled)));
  const active = props.contracts.find((x) => x.status === "active");
  assert.equal(contractSide(active), null);
});

test("prices.buy.{yes,no} fallback when bestBid/bestAsk are absent, depth capped", () => {
  const contract = c("GEMI-X-A", { prices: { buy: { yes: "0.12", no: "0.89" }, sell: {} } });
  const book = getBook({ contracts: [contract] }, contract);
  assert.equal(book.asks[0].price, 0.12);
  assert.ok(Math.abs(book.bids[0].price - 0.11) < 1e-9);
  assert.ok(Number.isFinite(book.asks[0].qty), "top of book must never be infinitely deep");
  assert.ok(book.asks[1].price > book.asks[0].price, "deeper levels cost more (modeled slippage)");
});

test("outcome order is canonical: independent of API response order", () => {
  const a = moneyline([c("GEMI-NFL-2611221800-DAL-PHI-M-PHI"), c("GEMI-NFL-2611221800-DAL-PHI-M-DAL")]);
  const b = moneyline([...a.contracts].reverse());
  for (const sym of a.contracts.map((x) => x.instrumentSymbol)) {
    assert.equal(outcomeIndex(a, sym, "YES"), outcomeIndex(b, sym, "YES"));
  }
  assert.equal(hedgeTarget(a, 0).instrumentSymbol, "GEMI-NFL-2611221800-DAL-PHI-M-DAL");
  assert.deepEqual(orderedContracts(a).map((x) => x.instrumentSymbol), orderedContracts(b).map((x) => x.instrumentSymbol));
});

test("settler and pricer agree on the winning index", () => {
  const ev = moneyline([
    c("GEMI-NFL-2611221800-DAL-PHI-M-PHI", { status: "settled", resolutionSide: "yes" }),
    c("GEMI-NFL-2611221800-DAL-PHI-M-DAL", { status: "settled", resolutionSide: "no" }),
  ]);
  assert.equal(settledOutcome(ev), outcomeIndex(ev, "GEMI-NFL-2611221800-DAL-PHI-M-PHI", "YES"));
});

test("multi-outcome events: YES only; binary events: YES=0, NO=1", () => {
  const ml = moneyline([c("GEMI-M-A"), c("GEMI-M-B")]);
  assert.throws(() => outcomeIndex(ml, "GEMI-M-A", "NO"), /YES/);
  const bin = { ticker: "B", contracts: [c("GEMI-B-YES")] };
  assert.equal(outcomeIndex(bin, "GEMI-B-YES", "YES"), 0);
  assert.equal(outcomeIndex(bin, "GEMI-B-YES", "NO"), 1);
  assert.equal(hedgeTarget(bin, 1).side, "NO");
});

test("more than 16 mutually exclusive outcomes is refused", () => {
  const ev = { ticker: "F", sportsMarket: { type: "futures" }, contracts: Array.from({ length: 17 }, (_, i) => c(`GEMI-F-${String(i).padStart(2, "0")}`)) };
  assert.throws(() => outcomeIndex(ev, "GEMI-F-00", "YES"), /16/);
});

// ---------------------------------------------------------------- real moneyline (NFL)
const ml = JSON.parse(fs.readFileSync(new URL("./fixtures/gemini-events-moneyline.json", import.meta.url), "utf8"));
const game = ml.data[0];
const { listActiveEvents } = await import("../src/gemini.js");
const { salesWindow } = await import("../src/pricer.js");

test("real NFL moneyline: coverable, open, live prices", () => {
  assert.equal(game.sportsMarket.type, "moneyline");
  assert.equal(isMutuallyExclusive(game), true);
  for (const k of game.contracts) assert.equal(k.marketState, "open");
  const ari = game.contracts.find((k) => k.instrumentSymbol.endsWith("-ARI"));
  assert.ok(Number(ari.prices.bestAsk) > 0 && Number(ari.prices.bestAsk) < 0.5, "underdog priced as a long shot");
});

test("underdog cover: book walk adds modeled slippage beyond top-of-book depth", () => {
  const ari = game.contracts.find((k) => k.instrumentSymbol.endsWith("-ARI"));
  const ask = Number(ari.prices.bestAsk);
  const book = getBook(game, ari);
  const small = executablePrice(book, "YES", 500);
  const large = executablePrice(book, "YES", 5000);
  assert.ok(Math.abs(small.avgPrice - ask) < 1e-9);
  assert.ok(large.avgPrice > ask, "a $5k cover must cost more per contract than a $500 one");
  assert.equal(large.filled, 5000);
});

test("listing flattens child period markets (2nd-half winner) with parentTicker", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async (url) => ({
    ok: true,
    text: async () => JSON.stringify(String(url).includes("moneyline") ? ml : { data: [], pagination: { total: 0 } }),
  });
  try {
    const events = await listActiveEvents();
    const half = events.find((e) => e.ticker.endsWith("-2HM"));
    assert.ok(half, "2nd-half market listed");
    assert.equal(half.parentTicker, game.ticker);
    assert.equal(half.contracts.length, 3, "includes the tie contract");
    assert.equal(isMutuallyExclusive(half), true);
    assert.equal(events.filter((e) => e.ticker === game.ticker).length, 1);
  } finally {
    globalThis.fetch = orig;
  }
});

test("sales window: pre-game closes at kickoff; in-game is short-lived", () => {
  const start = Math.floor(Date.parse(game.startTime) / 1000);
  const pre = salesWindow(game, start - 3600);
  assert.equal(pre.mode, "pre-game");
  assert.equal(pre.salesClose, start);
  assert.ok(pre.expiry <= start);
  const live = salesWindow(game, start + 1800);
  assert.equal(live.mode, "in-game");
  assert.ok(live.salesClose - (start + 1800) <= 60);
});
