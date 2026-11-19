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
