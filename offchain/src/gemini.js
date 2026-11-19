// Gemini Prediction Markets client: public market data + sandbox orders.
// Docs: https://developer.gemini.com/products/prediction-markets
import crypto from "node:crypto";
import { config } from "./config.js";

const MOCK_EVENT = {
  ticker: "DEMO-UNDERDOG",
  title: "Demo: Will the underdog win the rivalry game?",
  status: "active",
  expiry: new Date(Date.now() + 2 * 86400_000).toISOString(),
  contracts: [
    {
      ticker: "DEMO-UNDERDOG-YES",
      label: "Underdog wins",
      status: "active",
      marketState: "open",
      instrumentSymbol: "GEMI-DEMO-UNDERDOG",
      prices: { bestBid: "0.10", bestAsk: "0.11", lastTradePrice: "0.105" },
    },
  ],
  // YES-space book: asks ascending, bids descending. [price, quantity in contracts]
  mockBook: {
    asks: [["0.11", "2000"], ["0.12", "2500"], ["0.14", "4000"], ["0.17", "8000"]],
    bids: [["0.10", "3000"], ["0.09", "5000"], ["0.07", "9000"]],
  },
};

async function getText(url) {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  const text = await res.text();
  if (!res.ok) throw new Error(`Gemini ${res.status} for ${url}`);
  return text;
}
const getJson = async (url) => JSON.parse(await getText(url));

// Championship: one contract per team, mutually exclusive. Long shots everywhere.
const TEAMS = [
  ["TEX", "Texas", "0.14"], ["OSU", "Ohio State", "0.18"], ["UGA", "Georgia", "0.16"], ["ORE", "Oregon", "0.12"],
  ["ND", "Notre Dame", "0.09"], ["PSU", "Penn State", "0.11"], ["MIA", "Miami", "0.08"], ["BC", "Boston College", "0.04"],
];
const MOCK_CHAMP = {
  ticker: "DEMO-CHAMP",
  title: "Demo: Who wins the college football championship?",
  status: "active",
  sportsMarket: { sport: "american_football", type: "futures", subject: "team", scope: { type: "competition" } },
  expiry: new Date(Date.now() + 30 * 86400_000).toISOString(),
  contracts: TEAMS.map(([code, name, ask]) => ({
    ticker: `DEMO-CHAMP-${code}`,
    label: name,
    status: "active",
    marketState: "open",
    instrumentSymbol: `GEMI-DEMO-CHAMP-${code}`,
    prices: { bestBid: (Number(ask) - 0.01).toFixed(2), bestAsk: ask },
    mockBook: {
      asks: [[ask, "3000"], [(Number(ask) + 0.01).toFixed(2), "4000"], [(Number(ask) + 0.03).toFixed(2), "10000"]],
      bids: [[(Number(ask) - 0.01).toFixed(2), "3000"], [(Number(ask) - 0.02).toFixed(2), "6000"]],
    },
  })),
};
const MOCKS = { [MOCK_EVENT.ticker]: MOCK_EVENT, [MOCK_CHAMP.ticker]: MOCK_CHAMP };

/**
 * Active events Arra can cover. By default only market types whose contracts are mutually
 * exclusive: game winners (moneyline) and championship futures. Player props are excluded:
 * "2+ assists" and "4+ assists" can both resolve YES, so they cannot be netted.
 */
export async function listActiveEvents({ category = "sports", types = ["moneyline", "futures"], limit = 50 } = {}) {
  if (config.mockGemini) return Object.values(MOCKS);
  const base = `${config.geminiBase}/v1/prediction-markets/events?status=active&category=${encodeURIComponent(category)}&limit=${limit}`;
  const pages = await Promise.all(
    (types.length ? types : [null]).map((t) => getJson(t ? `${base}&sports_market_type=${encodeURIComponent(t)}` : base))
  );
  // Game markets nest period markets (quarters, halves) as child events[]. Flatten them so
  // e.g. the 2nd-half winner market is quotable for in-game ("halftime comeback") cover.
  const seen = new Set();
  const out = [];
  const add = (e, parentTicker = null) => {
    if (!e?.ticker || seen.has(e.ticker)) return;
    seen.add(e.ticker);
    const { events: children, ...rest } = e;
    out.push(parentTicker ? { ...rest, parentTicker } : rest);
    for (const c of children ?? []) add(c, e.ticker);
  };
  for (const d of pages) for (const e of Array.isArray(d) ? d : d.data ?? d.events ?? []) add(e);
  return out;
}

/** Event plus the exact response text (the settler hashes the raw bytes as evidence). */
export async function getEventRaw(ticker) {
  if (config.mockGemini) {
    if (!MOCKS[ticker]) throw new Error(`Unknown mock event ${ticker}`);
    return { event: MOCKS[ticker], raw: JSON.stringify(MOCKS[ticker]) };
  }
  const raw = await getText(`${config.geminiBase}/v1/prediction-markets/events/${encodeURIComponent(ticker)}`);
  const parsed = JSON.parse(raw);
  return { event: parsed.data && !Array.isArray(parsed.data) ? parsed.data : parsed, raw };
}

export async function getEvent(ticker) {
  return (await getEventRaw(ticker)).event;
}

export function findContract(event, instrumentSymbol) {
  const c = (event.contracts ?? []).find((x) => x.instrumentSymbol === instrumentSymbol);
  if (!c) throw new Error(`Contract ${instrumentSymbol} not found in event ${event.ticker}`);
  return c;
}

const num = (x) => (x == null ? NaN : Number(x));

/** Normalize a level that may be [p, q] or {price, quantity|size|qty}. */
function level(l) {
  if (Array.isArray(l)) return { price: num(l[0]), qty: num(l[1]) };
  return { price: num(l.price ?? l.p), qty: num(l.quantity ?? l.size ?? l.qty ?? l.amount) };
}

/**
 * Return the YES-space book {asks, bids} for a contract.
 * Uses event.contractOrderbooks when the API includes it; otherwise falls back
 * to top of book from contract.prices (one level, conservatively padded).
 */
export function getBook(event, contract) {
  const mock = contract.mockBook ?? event.mockBook;
  if (mock) {
    return { asks: mock.asks.map(level), bids: mock.bids.map(level), source: "mock" };
  }
  const books = event.contractOrderbooks;
  const raw =
    (books && (books[contract.instrumentSymbol] ?? books[contract.ticker])) ||
    (Array.isArray(books) && books.find((b) => b.instrumentSymbol === contract.instrumentSymbol));
  if (raw && (raw.asks || raw.bids)) {
    return {
      asks: (raw.asks ?? []).map(level).filter((l) => l.qty > 0).sort((a, b) => a.price - b.price),
      bids: (raw.bids ?? []).map(level).filter((l) => l.qty > 0).sort((a, b) => b.price - a.price),
      source: "orderbook",
    };
  }
  // No depth in the response (Gemini's list/get endpoints usually omit it): build a
  // conservative ladder from top of book. Level i is priced i ticks worse and holds
  // TOP_OF_BOOK_DEPTH contracts, so large covers pay modeled slippage instead of being
  // priced at the best ask. Gemini's prices object carries bestBid / bestAsk and
  // buy.{yes,no} (cost to buy each side); both are empty objects when nobody is quoting.
  const p = contract.prices ?? {};
  const ask = firstFinite(p.bestAsk, p.buy?.yes);
  const bid = firstFinite(p.bestBid, Number.isFinite(num(p.buy?.no)) ? 1 - num(p.buy.no) : NaN);
  const tick = firstFinite(contract.priceIncrement, 0.01);
  const depth = config.topOfBookDepth;
  const ladder = (start, dir) =>
    Number.isFinite(start)
      ? Array.from({ length: config.slippageLevels }, (_, i) => ({ price: round4(start + dir * i * tick), qty: depth }))
          .filter((l) => l.price > 0 && l.price < 1)
      : [];
  return { asks: ladder(ask, +1), bids: ladder(bid, -1), source: "top-of-book+slippage" };
}

const round4 = (x) => Math.round(x * 1e4) / 1e4;

function firstFinite(...xs) {
  for (const x of xs) if (Number.isFinite(num(x))) return num(x);
  return NaN;
}

/**
 * Average price to BUY `contracts` of the given side by walking the book.
 * YES buys lift asks. NO buys hit YES bids at (1 - bid).
 * Returns { avgPrice, filled, levelsUsed, worstPrice }.
 */
export function executablePrice(book, side, contracts) {
  const levels =
    side === "YES" ? book.asks : book.bids.map((l) => ({ price: 1 - l.price, qty: l.qty }));
  let remaining = contracts;
  let cost = 0;
  let levelsUsed = 0;
  let worst = NaN;
  for (const l of levels) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, l.qty);
    cost += take * l.price;
    remaining -= take;
    levelsUsed++;
    worst = l.price;
  }
  const filled = contracts - remaining;
  return { avgPrice: filled > 0 ? cost / filled : NaN, filled, levelsUsed, worstPrice: worst };
}

// ---------------------------------------------------------------- sandbox trading

function signedHeaders(path, body) {
  if (!config.geminiKey || !config.geminiSecret) throw new Error("GEMINI_API_KEY / GEMINI_API_SECRET not set");
  const payload = { request: path, nonce: Date.now().toString(), ...body };
  const b64 = Buffer.from(JSON.stringify(payload)).toString("base64");
  const sig = crypto.createHmac("sha384", config.geminiSecret).update(b64).digest("hex");
  return {
    "Content-Type": "text/plain",
    "Content-Length": "0",
    "X-GEMINI-APIKEY": config.geminiKey,
    "X-GEMINI-PAYLOAD": b64,
    "X-GEMINI-SIGNATURE": sig,
    "Cache-Control": "no-cache",
  };
}

/** Place a limit buy on the Gemini SANDBOX. Returns the parsed order response. */
export async function placeSandboxOrder({ symbol, side = "buy", outcome = "yes", quantity, price }) {
  const path = "/v1/prediction-markets/order";
  const body = {
    symbol,
    orderType: "limit",
    side,
    outcome,
    quantity: String(quantity),
    price: String(price),
    timeInForce: "immediate-or-cancel",
  };
  const res = await fetch(config.geminiSandboxBase + path, { method: "POST", headers: signedHeaders(path, body) });
  const text = await res.text();
  if (!res.ok) throw new Error(`Gemini sandbox order failed ${res.status}: ${text}`);
  return JSON.parse(text);
}

// ---------------------------------------------------------------- outcome mapping

const EXCLUSIVE_TYPES = new Set(["moneyline", "futures"]);

/**
 * True when at most one contract of the event can resolve YES, so the vault may lock
 * max_i L_i instead of the sum. Single-contract events are binary (YES vs NO).
 */
export function isMutuallyExclusive(event) {
  const n = (event.contracts ?? []).length;
  if (n <= 1) return true;
  return EXCLUSIVE_TYPES.has(event.sportsMarket?.type);
}

/**
 * Contracts in canonical order: sorted by instrumentSymbol. Index i in this list is vault
 * outcome i. Deterministic and independent of API response order, so the pricer, hedger,
 * settler and the public verify page all derive the same mapping from the same event.
 */
export function orderedContracts(event) {
  return [...(event.contracts ?? [])].sort((a, b) => (a.instrumentSymbol < b.instrumentSymbol ? -1 : 1));
}

/**
 * Map (event, contract, side) to the vault's mutually exclusive outcome index.
 *   - Multi-contract event (moneyline / futures): outcome i = "contract i resolves YES". YES only.
 *   - Single-contract event: 0 = YES, 1 = NO.
 */
export function outcomeIndex(event, instrumentSymbol, side) {
  const contracts = orderedContracts(event);
  const i = contracts.findIndex((c) => c.instrumentSymbol === instrumentSymbol);
  if (i < 0) throw new Error(`Contract ${instrumentSymbol} not in event ${event.ticker}`);
  if (contracts.length === 1) return side === "NO" ? 1 : 0;
  if (!isMutuallyExclusive(event)) {
    throw new Error("This market's outcomes are not mutually exclusive (e.g. player props); Arra covers game winners and championships");
  }
  if (side !== "YES") throw new Error("On multi-outcome events, cover the team you are rooting for (YES)");
  if (contracts.length > 16) throw new Error("Vault supports up to 16 outcomes per event");
  return i;
}

/** Inverse of outcomeIndex: which Gemini contract and side to buy to hedge outcome i. */
export function hedgeTarget(event, outcome) {
  const contracts = orderedContracts(event);
  if (contracts.length === 1) return { instrumentSymbol: contracts[0].instrumentSymbol, side: outcome === 1 ? "NO" : "YES" };
  return { instrumentSymbol: contracts[outcome].instrumentSymbol, side: "YES" };
}
