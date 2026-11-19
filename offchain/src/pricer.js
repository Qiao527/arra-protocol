// Pricer: turns live Gemini order-book depth into a signed, 60-second cover quote.
//   GET  /events             active sports events with top-of-book
//   POST /quote              { eventTicker, instrumentSymbol, side, payoutUsdc, buyer }
//   GET  /health
import express from "express";
import cors from "cors";
import crypto from "node:crypto";
import { getAddress } from "viem";
import { config } from "./config.js";
import { listActiveEvents, getEvent, findContract, getBook, executablePrice, outcomeIndex, orderedContracts, isMutuallyExclusive, ensureDepth } from "./gemini.js";
import { computePremium, riskAfterTrade, toUsdcUnits, premiumUnits } from "./pricing.js";
import { operatorAccount, eventIdFor, quoteTypes, domain, readEventBooks } from "./chain.js";
import { remember } from "./registry.js";

/** Scheduled start of the event (seconds). Prefer explicit start fields; fall back to expiry. */
export function eventStartOf(event) {
  const t =
    event.startTime ?? event.startDate ?? event.eventStartTime ?? event.closeTime ?? event.expiryDate ?? event.expiry;
  const sec = Math.floor(new Date(t).getTime() / 1000);
  if (!Number.isFinite(sec)) throw new Error(`Event ${event.ticker} has no usable start/expiry time`);
  return sec;
}

// How long after the scheduled start in-game cover may still be sold, by sport. Well inside a
// regulation game: a finished game must never be quotable, and Gemini does not say when it ends.
// Shortest regulation games: college basketball ~2 h, MLB ~2 h 40, soccer ~1 h 55.
const IN_GAME_MAX_SEC = {
  basketball: 1.5 * 3600,
  american_football: 2.5 * 3600,
  ice_hockey: 2 * 3600,
  baseball: 2.5 * 3600,
  soccer: 1.5 * 3600,
};
export const inGameMaxSec = (event) =>
  config.inGameMaxSec ?? IN_GAME_MAX_SEC[event.sportsMarket?.sport] ?? 1.5 * 3600;

/**
 * Sales window for a quote.
 *   Pre-game: sales close at kickoff; the quote lives QUOTE_TTL_SEC.
 *   In-game:  only within inGameMaxSec of the scheduled start. Gemini keeps finished games open
 *             (marketState "open", isLive true) until it settles, sometimes for days, so the
 *             market state alone would let anyone who knows the final score buy the winner.
 *             Sales close and quote expiry are both IN_GAME_TTL_SEC out, because live prices
 *             move with every play.
 */
export function salesWindow(event, now = Math.floor(Date.now() / 1000)) {
  const start = eventStartOf(event);
  if (now < start) return { mode: "pre-game", salesClose: start, expiry: Math.min(start, now + config.quoteTtlSec) };
  if (!config.allowInGame) throw new Error("Sales closed: the event has started");
  const max = inGameMaxSec(event);
  if (now - start > max) {
    throw new Error(`Sales closed: the game is likely over (${((now - start) / 3600).toFixed(1)} h after start, in-game limit ${max / 3600} h)`);
  }
  const close = now + config.inGameTtlSec;
  return { mode: "in-game", salesClose: close, expiry: close };
}

class ClientError extends Error {
  status = 400;
}
const TICKER = /^[A-Z0-9][A-Z0-9-]{0,99}$/;

/** Validate and normalize a POST /quote body. Throws ClientError (400) on bad input. */
export function validateQuoteRequest(body = {}) {
  const { eventTicker, instrumentSymbol, side = "YES", payoutUsdc, buyer } = body ?? {};
  if (typeof eventTicker !== "string" || !TICKER.test(eventTicker)) throw new ClientError("eventTicker: expected a Gemini event ticker");
  if (typeof instrumentSymbol !== "string" || !TICKER.test(instrumentSymbol)) throw new ClientError("instrumentSymbol: expected a Gemini instrumentSymbol");
  if (!["YES", "NO"].includes(side)) throw new ClientError("side must be YES or NO");
  const L = typeof payoutUsdc === "number" ? payoutUsdc : /^\d+(\.\d{1,6})?$/.test(String(payoutUsdc)) ? Number(payoutUsdc) : NaN;
  if (!(L > 0) || L > config.maxPayoutUsdc) throw new ClientError(`payoutUsdc must be > 0 and <= ${config.maxPayoutUsdc}`);
  if (typeof buyer !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(buyer)) throw new ClientError("buyer: expected a 0x address");
  return { eventTicker, instrumentSymbol, side, payoutUsdc: L, buyer: getAddress(buyer.toLowerCase()) };
}

export async function buildQuote(req) {
  const { eventTicker, instrumentSymbol, side, payoutUsdc, buyer } = validateQuoteRequest(req);
  const L = payoutUsdc;
  const buyerAddr = buyer;

  const event = await getEvent(eventTicker);
  const contract = findContract(event, instrumentSymbol);
  if (contract.marketState && contract.marketState !== "open") throw new Error("Market is closed");

  await ensureDepth(contract.instrumentSymbol); // real depth when the stream is up, modeled otherwise
  const book = getBook(event, contract);
  const fill = executablePrice(book, side, L); // 1 contract pays $1, so L contracts cover L USDC
  if (!(fill.filled >= L)) {
    throw new Error(`Not enough Gemini depth to hedge ${L} contracts (only ${Math.floor(fill.filled)} on the ${book.source} book)`);
  }
  if (fill.avgPrice > config.maxProbability) {
    throw new Error(
      `Market prices this at ${(fill.avgPrice * 100).toFixed(1)}%: cover on a likely outcome is poor value. Pick a long shot.`
    );
  }

  // Vault books -> netting discount and convex utilization surcharge.
  const eventId = eventIdFor(event.ticker);
  const pinned = remember(eventId, { eventTicker: event.ticker, title: event.title }, event); // indexes sold never move
  const outcome = outcomeIndex(event, instrumentSymbol, side, pinned);
  const books = await readEventBooks(eventId, outcome + 1);
  if (books.state !== "None" && books.state !== "Open") throw new Error(`Event is ${books.state}: sales closed`);
  const risk = riskAfterTrade({ ...books, outcome, payout: L });
  if (risk.exceedsCap) {
    throw new Error(
      `Vault capacity reached on this event (worst case would be $${risk.worstAfter.toFixed(0)} vs cap $${risk.cap.toFixed(0)}). Try a smaller payout.`
    );
  }

  const breakdown = computePremium({
    payoutUsdc: L,
    pExec: fill.avgPrice,
    hedgeBufferBps: config.hedgeBufferBps,
    capitalChargeBps: config.capitalChargeBps,
    surchargeKBps: config.surchargeKBps,
    utilization: risk.utilization,
    deltaLockedUsdc: risk.deltaLocked,
  });

  const now = Math.floor(Date.now() / 1000);
  const win = salesWindow(event, now);

  const quote = {
    eventId,
    outcome,
    payout: toUsdcUnits(L),
    premium: premiumUnits(breakdown),
    expiry: BigInt(win.expiry),
    eventStart: BigInt(win.salesClose),
    buyer: buyerAddr,
    nonce: BigInt("0x" + crypto.randomBytes(16).toString("hex")),
  };

  const signature = await operatorAccount().signTypedData({
    domain: domain(),
    types: quoteTypes,
    primaryType: "Quote",
    message: quote,
  });

  return {
    quote: Object.fromEntries(Object.entries(quote).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v])),
    signature,
    breakdown: { ...breakdown, premium: Number(premiumUnits(breakdown)) / 1e6, pExec: Number(fill.avgPrice.toFixed(4)), levelsUsed: fill.levelsUsed, bookSource: book.source },
    vaultAfter: { lockedOnEvent: risk.lockedAfter, insuredVolume: risk.insuredVolume, worstCase: risk.worstAfter, cap: risk.cap },
    market: { eventTicker: event.ticker, title: event.title, contract: contract.label, instrumentSymbol, side, outcome, mode: win.mode, startTime: eventStartOf(event) },
  };
}

/** Fixed-window per-IP limiter (in memory: one instance per process is enough for the MVP). */
function rateLimiter({ windowMs, max }) {
  const hits = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const k = req.ip;
    let h = hits.get(k);
    if (!h || now >= h.reset) {
      h = { n: 0, reset: now + windowMs };
      hits.set(k, h);
      if (hits.size > 50_000) for (const [ip, v] of hits) if (now >= v.reset) hits.delete(ip);
    }
    if (++h.n > max) {
      res.set("Retry-After", String(Math.ceil((h.reset - now) / 1000)));
      return res.status(429).json({ error: "Too many requests" });
    }
    next();
  };
}

/** Status for an error thrown while quoting: bad input 400, Gemini / RPC trouble 502. */
export const statusOf = (err) =>
  err.status ?? (/^Gemini \d+|HTTP request failed|fetch failed|ECONN|timeout|exceeds defined limit|rate limit|\b429\b/i.test(err.message) ? 502 : 400);
const publicMessage = (err) => (statusOf(err) === 502 ? "Upstream unavailable (Gemini or Arc RPC); try again" : err.message.split("\n")[0]);

export function app({
  allowedOrigins = config.allowedOrigins,
  rateLimit = { windowMs: 60_000, max: config.rateLimitPerMin },
} = {}) {
  const a = express();
  a.disable("x-powered-by");
  a.set("trust proxy", config.trustProxy);
  a.use(cors({ origin: allowedOrigins, methods: ["GET", "POST"], allowedHeaders: ["content-type"], maxAge: 600 }));
  a.use(rateLimiter(rateLimit));
  a.use(express.json({ limit: "10kb" }));

  a.get("/health", (_req, res) => res.json({ ok: true, mock: config.mockGemini, operator: operatorAccount().address }));

  a.get("/events", async (req, res) => {
    try {
      const events = await listActiveEvents({ category: req.query.category ?? "sports" });
      res.json(
        events.map((e) => ({
          ticker: e.ticker,
          title: e.title,
          startTime: e.startTime ?? null,
          expiry: e.expiryDate ?? e.expiry ?? null,
          sportsMarket: e.sportsMarket ?? null,
          parentTicker: e.parentTicker ?? null,
          participants: e.participants ?? [],
          coverable: isMutuallyExclusive(e),
          contracts: orderedContracts(e).map((c, outcome) => ({
            outcome,
            label: c.label,
            instrumentSymbol: c.instrumentSymbol,
            marketState: c.marketState,
            prices: c.prices,
            color: c.color ?? null,
            imageUrl: c.imageUrl ?? null,
          })),
        }))
      );
    } catch (err) {
      console.error(`/events: ${err.message}`);
      res.status(502).json({ error: "Upstream unavailable (Gemini); try again" });
    }
  });

  a.post("/quote", async (req, res) => {
    try {
      res.json(await buildQuote(req.body));
    } catch (err) {
      if (statusOf(err) === 502) console.error(`/quote: ${err.message}`);
      res.status(statusOf(err)).json({ error: publicMessage(err) });
    }
  });

  // Body too large / malformed JSON
  a.use((err, _req, res, _next) => res.status(err.status ?? 500).json({ error: err.status === 413 ? "Request too large" : "Bad request" }));

  return a;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  app().listen(config.port, () =>
    console.log(`Pricer on :${config.port} (mock Gemini: ${config.mockGemini}, operator ${operatorAccount().address})`)
  );
}
