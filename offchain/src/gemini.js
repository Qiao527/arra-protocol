// Gemini Prediction Markets client: public market data + sandbox orders.
// Docs: https://developer.gemini.com/products/prediction-markets
import crypto from "node:crypto";
import { config } from "./config.js";
import { createDepthStream } from "./depth.js";

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
export async function listActiveEvents({
  category = "sports",
  types = ["moneyline", "futures"],
  searches = ["Champion"], // championships are tagged eventTags[futures], not sports_market_type
  limit = 50,
  maxPages = 1, // the keeper's registry recovery pages through everything (~1,400 events, ~15 s)
} = {}) {
  if (config.mockGemini) return Object.values(MOCKS);
  const base = `${config.geminiBase}/v1/prediction-markets/events?status=active&category=${encodeURIComponent(category)}&limit=${limit}`;
  const urls = [
    ...types.map((t) => `${base}&sports_market_type=${encodeURIComponent(t)}`),
    ...searches.map((q) => `${base}&search=${encodeURIComponent(q)}`),
  ];
  // Page through every result: with one page per query, live games past the first `limit`
  // never reached the pricer's list or the keeper's registry recovery.
  const allPages = async (url) => {
    const out = [];
    for (let offset = 0, page = 0; page < maxPages; page++, offset += limit) {
      const d = await getJson(`${url}&offset=${offset}`);
      const rows = Array.isArray(d) ? d : d.data ?? d.events ?? [];
      out.push(rows);
      const total = d.pagination?.total;
      if (rows.length < limit || (Number.isFinite(total) && offset + limit >= total)) break;
    }
    return out;
  };
  const pages = (await Promise.all((urls.length ? urls : [base]).map(allPages))).flat();
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
  for (const rows of pages) for (const e of rows) add(e);
  return out;
}

/**
 * Event plus the exact response bytes. The settler hashes `bytes` as evidence; text() would
 * decode (and drop a BOM), so the hash would not be over what Gemini actually sent.
 */
export async function getEventRaw(ticker) {
  if (config.mockGemini) {
    if (!MOCKS[ticker]) throw new Error(`Unknown mock event ${ticker}`);
    const raw = JSON.stringify(MOCKS[ticker]);
    return { event: MOCKS[ticker], raw, bytes: new TextEncoder().encode(raw) };
  }
  const url = `${config.geminiBase}/v1/prediction-markets/events/${encodeURIComponent(ticker)}`;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (!res.ok) throw new Error(`Gemini ${res.status} for ${url}`);
  const raw = new TextDecoder().decode(bytes).replace(/^\uFEFF/, "");
  const parsed = JSON.parse(raw);
  return { event: parsed.data && !Array.isArray(parsed.data) ? parsed.data : parsed, raw, bytes };
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

// Live depth lookup (symbol -> fresh YES-space book or null). Services that run the
// WebSocket stream register it with useDepth(stream.getDepthBook); see depth.js.
let liveDepth = () => null;
export const useDepth = (fn) => (liveDepth = fn ?? (() => null));

let depthStream = null;
/**
 * Make sure real depth for `instrumentSymbol` is streaming, and wait (briefly) for its first
 * snapshot. No-op with MOCK_GEMINI or WS_DEPTH=false. getBook then reports "ws-depth".
 */
export async function ensureDepth(instrumentSymbol, timeoutMs = 1_500) {
  if (config.mockGemini || !config.wsDepth || !globalThis.WebSocket) return false;
  if (!depthStream) {
    depthStream = createDepthStream();
    useDepth(depthStream.getDepthBook);
  }
  return depthStream.watch(instrumentSymbol, timeoutMs);
}
/** Close the depth socket (scripts call this so the process can exit). */
export function stopDepth() {
  depthStream?.close();
  depthStream = null;
  useDepth(null);
}

/**
 * Return the YES-space book {asks, bids, source} for a contract, best source first:
 *   "ws-depth"              real depth from Gemini's WebSocket, when fresh (< 5 s)
 *   "orderbook"             event.contractOrderbooks, if the REST API ever includes it
 *   "top-of-book+slippage"  modeled ladder from bestAsk / bestBid (REST has no depth)
 */
export function getBook(event, contract, depthBook = liveDepth) {
  const mock = contract.mockBook ?? event.mockBook;
  if (mock) {
    return { asks: mock.asks.map(level), bids: mock.bids.map(level), source: "mock" };
  }
  const live = depthBook?.(contract.instrumentSymbol);
  if (live) return live;
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
  // priced at the best ask. Only bestAsk / bestBid are executable. buy/sell.{yes,no} are
  // display prices that fall back to the other side when one side is empty (live data: with
  // no ask, buy.yes equals the bid), so they never stand in for a missing side.
  const p = contract.prices ?? {};
  const ask = num(p.bestAsk);
  const bid = num(p.bestBid);
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

// Time-based nonce in SECONDS: the sandbox rejects anything not "within 30 seconds of server
// time" (it rejected milliseconds). Strictly increasing so two calls in one second differ.
let lastNonce = 0;
export const nextNonce = (nowMs = Date.now()) => (lastNonce = Math.max(Math.floor(nowMs / 1000), lastNonce + 1));

export function signedHeaders(path, body) {
  if (!config.geminiKey || !config.geminiSecret) throw new Error("GEMINI_API_KEY / GEMINI_API_SECRET not set");
  // Gemini wants the nonce as a JSON number ("InvalidNonce ... not parseable as a number" for a string).
  const payload = { request: path, nonce: nextNonce(), ...body };
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

/** Signed POST to the Gemini SANDBOX (HMAC-SHA384 payload auth). Returns the parsed JSON body. */
async function sandboxPost(path, body = {}) {
  const res = await fetch(config.geminiSandboxBase + path, { method: "POST", headers: signedHeaders(path, body) });
  const text = await res.text();
  if (!res.ok) throw new Error(`Gemini sandbox ${path} failed ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

/** One-time: accept the Prediction Markets terms on the sandbox account (required before trading). */
export const acceptSandboxTerms = () => sandboxPost("/v1/prediction-markets/terms/accept");

/**
 * Parse an order response, keeping orderId exact. Gemini sends orderId as a bare JSON number
 * above 2^53 (e.g. 145853902323006128), which JSON.parse silently rounds to a different order.
 */
export function parseOrderResponse(raw) {
  return JSON.parse(raw, (k, v, ctx) => (k === "orderId" && typeof v === "number" ? (ctx?.source ?? String(raw.match(/"orderId"\s*:\s*(\d+)/)?.[1] ?? v)) : v));
}

/** Gemini event ticker for a contract symbol: GEMI-<EVENT>-<CONTRACT>. */
export const eventTickerOf = (instrumentSymbol) => String(instrumentSymbol).replace(/^GEMI-/, "").replace(/-[^-]+$/, "");

/**
 * Which SANDBOX contract hedges a production contract. The sandbox lists different markets
 * than production (no sports at all on 2026-11-19), so SANDBOX_SYMBOL_MAP maps production
 * instrumentSymbols to sandbox stand-ins; unmapped symbols are used as they are.
 */
export function sandboxSymbolFor(instrumentSymbol, map = config.sandboxSymbolMap) {
  return map?.[instrumentSymbol] ?? instrumentSymbol;
}

/** Best ask (YES space) of a SANDBOX contract, for the stand-in's IOC limit price. */
export async function sandboxBestAsk(instrumentSymbol) {
  const raw = await getText(`${config.geminiSandboxBase}/v1/prediction-markets/events/${encodeURIComponent(eventTickerOf(instrumentSymbol))}`);
  const parsed = JSON.parse(raw);
  const ev = parsed.data && !Array.isArray(parsed.data) ? parsed.data : parsed;
  const c = (ev.contracts ?? []).find((x) => x.instrumentSymbol === instrumentSymbol);
  if (!c || c.marketState !== "open") throw new Error(`sandbox contract ${instrumentSymbol} not open`);
  return { ask: num(c.prices?.bestAsk), bid: num(c.prices?.bestBid) };
}

/** Place a limit buy on the Gemini SANDBOX. Returns the parsed order response (orderId as a string). */
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
  return parseOrderResponse(text);
}

// ---------------------------------------------------------------- outcome mapping

const EXCLUSIVE_TYPES = new Set(["moneyline", "futures"]);
export const MAX_OUTCOMES = 128; // ArraVault.MAX_OUTCOMES

/**
 * True when at most one contract of the event can resolve YES, so the vault may lock
 * max_i L_i instead of the sum. Single-contract events are binary (YES vs NO).
 *   - Game and period winners: sportsMarket.type "moneyline".
 *   - Championships: Gemini tags them eventTags[futures] without a sportsMarket object, and
 *     the futures tag also covers non-exclusive season props (e.g. win totals), so we
 *     additionally require a single-winner title ("Champion", "Championship Winner", "Cup").
 */
export function isMutuallyExclusive(event) {
  const n = (event.contracts ?? []).length;
  if (n <= 1) return true;
  if (EXCLUSIVE_TYPES.has(event.sportsMarket?.type)) return true;
  const futures = (event.eventTags ?? []).some((t) => t?.slug === "futures");
  return futures && event.type === "categorical" && /\b(champion|championship winner|cup)\b/i.test(event.title ?? "");
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
 * Outcome order with the indexes already sold pinned. `pinned` is the canonical order stored at
 * the event's first sale (registry); contracts Gemini lists later get the next free indexes, in
 * sorted order. Without a pin this is the canonical sorted order.
 */
export function outcomeSymbols(event, pinned) {
  const sorted = orderedContracts(event).map((c) => c.instrumentSymbol);
  if (!pinned?.length) return sorted;
  return [...pinned, ...sorted.filter((s) => !pinned.includes(s))];
}

/**
 * Map (event, contract, side) to the vault's mutually exclusive outcome index.
 *   - Multi-contract event (moneyline / futures): outcome i = "contract i resolves YES". YES only.
 *   - Single-contract event: 0 = YES, 1 = NO.
 */
export function outcomeIndex(event, instrumentSymbol, side, pinned) {
  const contracts = orderedContracts(event);
  if (!contracts.some((c) => c.instrumentSymbol === instrumentSymbol)) throw new Error(`Contract ${instrumentSymbol} not in event ${event.ticker}`);
  const i = outcomeSymbols(event, pinned).indexOf(instrumentSymbol);
  if (contracts.length === 1) return side === "NO" ? 1 : 0;
  if (!isMutuallyExclusive(event)) {
    throw new Error("This market's outcomes are not mutually exclusive (e.g. player props); Arra covers game winners and championships");
  }
  if (side !== "YES") throw new Error("On multi-outcome events, cover the team you are rooting for (YES)");
  if (contracts.length > MAX_OUTCOMES || i >= MAX_OUTCOMES) throw new Error(`Vault supports up to ${MAX_OUTCOMES} outcomes per event`);
  return i;
}

/** Inverse of outcomeIndex: which Gemini contract and side to buy to hedge outcome i. */
export function hedgeTarget(event, outcome, pinned) {
  const contracts = orderedContracts(event);
  if (contracts.length === 1) return { instrumentSymbol: contracts[0].instrumentSymbol, side: outcome === 1 ? "NO" : "YES" };
  const symbol = outcomeSymbols(event, pinned)[outcome];
  if (!contracts.some((c) => c.instrumentSymbol === symbol)) throw new Error(`outcome ${outcome} (${symbol}) is no longer listed on ${event.ticker}`);
  return { instrumentSymbol: symbol, side: "YES" };
}
