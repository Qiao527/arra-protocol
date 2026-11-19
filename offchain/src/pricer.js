// Pricer: turns live Gemini order-book depth into a signed, 60-second cover quote.
//   GET  /events             active sports events with top-of-book
//   POST /quote              { eventTicker, instrumentSymbol, side, payoutUsdc, buyer }
//   GET  /health
import express from "express";
import cors from "cors";
import crypto from "node:crypto";
import { getAddress } from "viem";
import { config } from "./config.js";
import { listActiveEvents, getEvent, findContract, getBook, executablePrice, outcomeIndex, orderedContracts, isMutuallyExclusive } from "./gemini.js";
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
const IN_GAME_MAX_SEC = {
  basketball: 2 * 3600,
  american_football: 3 * 3600,
  ice_hockey: 2.5 * 3600,
  baseball: 3 * 3600,
  soccer: 2 * 3600,
};
export const inGameMaxSec = (event) =>
  config.inGameMaxSec ?? IN_GAME_MAX_SEC[event.sportsMarket?.sport] ?? 2 * 3600;

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

export async function buildQuote({ eventTicker, instrumentSymbol, side = "YES", payoutUsdc, buyer }) {
  if (!["YES", "NO"].includes(side)) throw new Error("side must be YES or NO");
  const L = Number(payoutUsdc);
  if (!(L > 0)) throw new Error("payoutUsdc must be > 0");
  const buyerAddr = getAddress(buyer);

  const event = await getEvent(eventTicker);
  const contract = findContract(event, instrumentSymbol);
  if (contract.marketState && contract.marketState !== "open") throw new Error("Market is closed");

  const book = getBook(event, contract);
  const fill = executablePrice(book, side, L); // 1 contract pays $1, so L contracts cover L USDC
  if (!(fill.filled >= L)) throw new Error(`Not enough Gemini depth to hedge ${L} contracts (only ${fill.filled})`);
  if (fill.avgPrice > config.maxProbability) {
    throw new Error(
      `Market prices this at ${(fill.avgPrice * 100).toFixed(1)}%: cover on a likely outcome is poor value. Pick a long shot.`
    );
  }

  // Vault books -> netting discount and convex utilization surcharge.
  const eventId = eventIdFor(event.ticker);
  const outcome = outcomeIndex(event, instrumentSymbol, side);
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

  remember(quote.eventId, { eventTicker: event.ticker, title: event.title });

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

export function app() {
  const a = express();
  a.use(cors());
  a.use(express.json());

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
      res.status(502).json({ error: err.message });
    }
  });

  a.post("/quote", async (req, res) => {
    try {
      res.json(await buildQuote(req.body));
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  return a;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  app().listen(config.port, () =>
    console.log(`Pricer on :${config.port} (mock Gemini: ${config.mockGemini}, operator ${operatorAccount().address})`)
  );
}
