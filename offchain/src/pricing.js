// Premium for a cover paying L if outcome o happens:
//
//   premium = L·p·(1 + b + k·u²)  +  r·ΔLocked·(1 − p)
//
//   p        executable price: average price to buy L contracts on Gemini (order-book walk)
//   b        base hedge buffer (spread / slippage between quote and hedge)
//   k, u     convex utilization surcharge: u = post-trade net exposure / per-event cap (0..1).
//            As one event fills up, each extra dollar of cover costs more.
//   r        capital charge on the collateral this cover ADDS to the vault's lock.
//   ΔLocked  increase in max_i L_i caused by this cover. A cover on another outcome
//            of an already-insured event adds little or no collateral, so it pays little or no
//            capital charge (outcome netting is passed on to merchants as a discount).

export function computePremium({
  payoutUsdc,
  pExec,
  hedgeBufferBps,
  capitalChargeBps,
  surchargeKBps = 0,
  utilization = 0, // post-trade u in [0, 1]
  deltaLockedUsdc = payoutUsdc, // default: no netting (fresh event)
}) {
  const b = hedgeBufferBps / 10_000;
  const r = capitalChargeBps / 10_000;
  const k = surchargeKBps / 10_000;
  const u = Math.min(1, Math.max(0, utilization));

  const hedgeCost = payoutUsdc * pExec;
  const buffer = hedgeCost * b;
  const utilizationSurcharge = hedgeCost * k * u * u;
  const capitalCharge = deltaLockedUsdc * r * (1 - pExec);
  const premium = hedgeCost + buffer + utilizationSurcharge + capitalCharge;

  return {
    hedgeCost: round2(hedgeCost),
    buffer: round2(buffer),
    utilizationSurcharge: round2(utilizationSurcharge),
    capitalCharge: round2(capitalCharge),
    premium: round2(premium),
    premiumExact: premium, // unrounded; the quote charges ceil(premiumExact) in USDC units
    premiumPctOfPayout: round2((premium / payoutUsdc) * 100),
    marketingMultiple: round2(payoutUsdc / premium),
    utilization: round2(u),
    deltaLocked: round2(deltaLockedUsdc),
  };
}

/**
 * Post-trade risk state for a new cover, from the vault's current books (USDC floats).
 * Mirrors ArraVault: locked = max_i L_i, worst unhedged = max_i (L_i - H_i).
 */
export function riskAfterTrade({ liab, hedged, totalAssets, capBps, outcome, payout }) {
  const n = Math.max(liab.length, outcome + 1);
  const L = [...Array(n).keys()].map((i) => (liab[i] ?? 0) + (i === outcome ? payout : 0));
  const H = [...Array(n).keys()].map((i) => hedged[i] ?? 0);
  const lockedBefore = Math.max(0, ...liab);
  const lockedAfter = Math.max(0, ...L);
  const worst = Math.max(0, ...L.map((l, i) => l - H[i]));
  const cap = (totalAssets * capBps) / 10_000;
  return {
    deltaLocked: Math.max(0, lockedAfter - lockedBefore),
    worstAfter: worst,
    insuredVolume: L.reduce((a, b) => a + b, 0),
    lockedAfter,
    cap,
    utilization: cap > 0 ? worst / cap : 1,
    exceedsCap: worst > cap,
  };
}

const round2 = (x) => Math.round(x * 100) / 100;

/** USDC has 6 decimals on Arc's ERC-20 interface. Round premium UP so the vault never undercharges. */
export const toUsdcUnits = (x) => BigInt(Math.ceil(x * 1e6));

/** Premium the quote charges, in USDC units: the exact premium rounded UP (never to the nearest cent). */
export const premiumUnits = (breakdown) => toUsdcUnits(breakdown.premiumExact);
