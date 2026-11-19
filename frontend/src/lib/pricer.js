// Pricer client. Live quotes need the pricer (it reads Gemini and signs with the operator key).
// Without it the app still browses a captured Gemini snapshot and shows indicative premiums.
import snapshot from "../data/snapshot.json";
import { PRICER_URL } from "./config.js";

export const pricerConfigured = () => !!PRICER_URL;

async function call(path, init) {
  const res = await fetch(`${PRICER_URL}${path}`, { ...init, headers: { "content-type": "application/json" } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `Pricer error ${res.status}`);
  return body;
}

/** { events, live, capturedAt } */
export async function loadEvents() {
  if (PRICER_URL) {
    try {
      const events = await call("/events");
      if (Array.isArray(events) && events.length) return { events: events.filter((e) => e.coverable), live: true };
    } catch {
      /* fall through to the snapshot */
    }
  }
  return { events: snapshot.events, live: false, capturedAt: snapshot.capturedAt };
}

export function requestQuote({ eventTicker, instrumentSymbol, payoutUsdc, buyer, side = "YES" }) {
  if (!PRICER_URL) throw new Error("Live pricer not connected");
  return call("/quote", { method: "POST", body: JSON.stringify({ eventTicker, instrumentSymbol, side, payoutUsdc, buyer }) });
}

// Same formula as offchain/src/pricing.js, for indicative numbers before a signed quote:
// premium = L·p·(1 + b + k·u²) + r·ΔLocked·(1 − p)
export function indicativePremium({ payout, ask, tick = 0.01, depth = 1000, b = 0.05, k = 0.2, r = 0.02, utilization = 0.5, deltaLocked = payout }) {
  let left = payout, cost = 0, i = 0;
  while (left > 0 && i < 10) {
    const q = Math.min(left, depth);
    cost += q * Math.min(0.99, ask + i * tick);
    left -= q;
    i++;
  }
  const p = cost / Math.max(1, payout - left);
  const hedge = payout * p;
  const buffer = hedge * b;
  const surcharge = hedge * k * utilization ** 2;
  const capital = r * deltaLocked * (1 - p);
  return { p, hedge, buffer, surcharge, capital, premium: hedge + buffer + surcharge + capital };
}
