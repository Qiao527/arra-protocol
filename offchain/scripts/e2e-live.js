// Live-data end to end on a local anvil chain: REAL Gemini markets, local vault, no secrets.
//   A) a real pre-game underdog moneyline   B) a real championship long shot
// Quotes come from the live API (and live WebSocket depth when reachable), covers are bought on
// anvil, the hedger runs dry, and each event is settled with a SYNTHETIC result in Gemini's
// settled shape (the real games have not finished), then checked with the public verifier.
import { createWalletClient, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { config, chain } from "../src/config.js";
import { publicClient, vaultAbi, eventIdFor } from "../src/chain.js";
import { buildQuote } from "../src/pricer.js";
import { hedgeIfNeeded } from "../src/hedger.js";
import { vote, finalizeAndPay } from "../src/settler.js";
import { listActiveEvents, getEvent, orderedContracts, isMutuallyExclusive, outcomeIndex, stopDepth } from "../src/gemini.js";
import { verifyEvidence, loadEvidence } from "../src/verify.js";

if (config.mockGemini) throw new Error("e2e-live needs MOCK_GEMINI=false");
const erc20 = parseAbi(["function approve(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)", "function mint(address,uint256)"]);
const USDC = process.env.USDC_ADDRESS;
const vault = { address: config.vault, abi: vaultAbi };
const wallet = (pk) => createWalletClient({ account: privateKeyToAccount(pk), chain: chain(), transport: http(config.rpcUrl) });
const send = async (w, req) => publicClient.waitForTransactionReceipt({ hash: await w.writeContract(req) });
const read = (functionName, args = []) => publicClient.readContract({ ...vault, functionName, args });
const bal = (a) => publicClient.readContract({ address: USDC, abi: erc20, functionName: "balanceOf", args: [a] });
const asArg = (q) => ({ ...q, payout: BigInt(q.payout), premium: BigInt(q.premium), expiry: BigInt(q.expiry), eventStart: BigInt(q.eventStart), nonce: BigInt(q.nonce) });
const fail = (m) => {
  console.error("FAIL:", m);
  process.exit(1);
};
const ask = (c) => Number(c.prices?.bestAsk);

const lp = wallet(process.env.LP_PK);
const bar = wallet(process.env.BAR_PKS.split(",")[0]);
for (const [w, amt] of [[lp, 100_000_000_000n], [bar, 10_000_000_000n]]) {
  await send(w, { address: USDC, abi: erc20, functionName: "mint", args: [w.account.address, amt] });
  await send(w, { address: USDC, abi: erc20, functionName: "approve", args: [config.vault, 2n ** 255n] });
}
await send(lp, { ...vault, functionName: "deposit", args: [100_000_000_000n, lp.account.address] });
console.log("1. LP deposited 100,000 USDC (local MockUSDC)");

/** Try a few sizes, largest first, so the cover fits the real book. */
async function buyLive(eventTicker, instrumentSymbol) {
  for (const payoutUsdc of [500, 200, 100, 50, 20]) {
    try {
      const q = await buildQuote({ eventTicker, instrumentSymbol, side: "YES", payoutUsdc, buyer: bar.account.address });
      await send(bar, { ...vault, functionName: "buyCover", args: [asArg(q.quote), q.signature] });
      return q;
    } catch (err) {
      console.log(`   ${instrumentSymbol} $${payoutUsdc}: ${err.message.split("\n")[0]}`);
    }
  }
  return null;
}

async function settleSynthetic(eventTicker, winnerSymbol) {
  const ev = await getEvent(eventTicker);
  const settled = {
    ...ev,
    status: "settled",
    contracts: ev.contracts.map((c) => ({ ...c, status: "settled", marketState: "closed", resolutionSide: c.instrumentSymbol === winnerSymbol ? "yes" : "no" })),
  };
  const bytes = new TextEncoder().encode(JSON.stringify({ data: settled }));
  await vote(eventTicker, outcomeIndex(ev, winnerSymbol, "YES"), bytes);
  await finalizeAndPay(eventTicker);
  const e = await read("events", [eventIdFor(eventTicker)]);
  const stored = loadEvidence({ dir: process.env.EVIDENCE_DIR, eventTicker, evidenceHash: e[6] });
  const r = stored && verifyEvidence({ bytes: stored, eventTicker, onchain: { state: "Settled", evidenceHash: e[6], winningOutcome: Number(e[1]) } });
  if (!r?.pass) fail(`verifier: ${JSON.stringify(r?.checks)}`);
  return r;
}

const events = await listActiveEvents();
const now = Date.now();
const results = [];

// ---- A) real pre-game underdog moneyline ------------------------------------------
const games = events
  .filter((e) => e.sportsMarket?.type === "moneyline" && !e.parentTicker && e.contracts?.length === 2 && Date.parse(e.startTime) > now + 10 * 60_000)
  .map((e) => ({ e, dog: orderedContracts(e).filter((c) => c.marketState === "open" && ask(c) > 0 && ask(c) <= 0.45).sort((a, b) => ask(a) - ask(b))[0] }))
  .filter((x) => x.dog);
let a = null;
for (const { e, dog } of games.slice(0, 6)) {
  console.log(`A. trying ${e.ticker} underdog ${dog.instrumentSymbol} (best ask ${dog.prices.bestAsk}, starts ${e.startTime})`);
  const q = await buyLive(e.ticker, dog.instrumentSymbol);
  if (q) {
    a = { e, dog, q };
    break;
  }
}
if (!a) fail("no live underdog moneyline could be quoted");
console.log(`A1. bought $${Number(a.q.quote.payout) / 1e6} cover on ${a.dog.label ?? a.dog.instrumentSymbol} for $${a.q.breakdown.premium} (p=${a.q.breakdown.pExec}, ${a.q.breakdown.bookSource}, ${a.q.market.mode})`);
results.push(["moneyline", a.e.ticker, a.q]);

// ---- B) real championship long shot ----------------------------------------------
const champs = events.filter((e) => /champ/i.test(e.ticker) && isMutuallyExclusive(e) && (e.contracts?.length ?? 0) > 2);
let b = null;
for (const e of champs.slice(0, 3)) {
  // Prefer a team past index 15: the settler used to reject those (REVIEW H-2).
  const order = orderedContracts(e);
  const shots = order
    .filter((c) => c.marketState === "open" && ask(c) > 0 && ask(c) <= 0.25)
    .sort((x, y) => (order.indexOf(y) >= 16) - (order.indexOf(x) >= 16) || ask(y) - ask(x));
  for (const team of shots.slice(0, 4)) {
    console.log(`B. trying ${e.ticker} ${team.instrumentSymbol} (best ask ${team.prices.bestAsk}, ${e.contracts.length} teams)`);
    const q = await buyLive(e.ticker, team.instrumentSymbol);
    if (q) {
      b = { e, team, q };
      break;
    }
  }
  if (b) break;
}
if (!b) fail("no live championship could be quoted");
console.log(`B1. bought $${Number(b.q.quote.payout) / 1e6} cover on ${b.team.label} (outcome ${b.q.market.outcome} of ${b.e.contracts.length}) for $${b.q.breakdown.premium} (${b.q.breakdown.bookSource})`);
results.push(["championship", b.e.ticker, b.q]);

for (const [, ticker] of results) {
  const h = await hedgeIfNeeded(eventIdFor(ticker));
  console.log(`H. hedger (dry run) ${ticker}: ${h.map((x) => `${x.qty} ${x.side} @ <= ${x.limit}`).join(", ") || "below retention, nothing to hedge"}`);
}

// ---- Settle: A's underdog wins, B's team wins (synthetic) ---------------------------
for (const [kind, ticker, q] of results) {
  const before = await bal(bar.account.address);
  const winner = kind === "moneyline" ? a.dog.instrumentSymbol : b.team.instrumentSymbol;
  const r = await settleSynthetic(ticker, winner);
  const got = (await bal(bar.account.address)) - before;
  console.log(`S. ${ticker}: settled on outcome ${r.impliedOutcome}, bar received ${Number(got) / 1e6} USDC, verifier PASS`);
  if (got !== BigInt(q.quote.payout)) fail(`${ticker} payout ${got} != ${q.quote.payout}`);
}
if ((await read("totalLocked")) !== 0n) fail("collateral not released");
stopDepth();
console.log("E2E LIVE OK");
process.exit(0);
