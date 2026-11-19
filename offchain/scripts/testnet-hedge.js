// Arc testnet, full flow with a REAL Gemini sandbox hedge:
//   LP deposit -> buy cover (real production market, live depth) -> hedger places a real IOC on the
//   Gemini SANDBOX -> recordHedge(filled qty, real Gemini order id) -> 3/3 votes -> claim -> sweep.
//
// The sandbox lists different markets than production (no sports on 2026-11-19), so the hedge goes
// to a sandbox STAND-IN contract via SANDBOX_SYMBOL_MAP (picked here if not set). The settlement
// result is SYNTHETIC (the real game has not been played); the evidence JSON says so.
//
// Env: RPC_URL, CHAIN_ID, VAULT_ADDRESS, OPERATOR_PRIVATE_KEY, SETTLER_PRIVATE_KEYS, MERCHANT_PK,
//      GEMINI_API_KEY / GEMINI_API_SECRET (sandbox, Trader role), LP_DEPOSIT_USDC, PAYOUT_USDC
import fs from "node:fs";
import { createWalletClient, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { config, chain } from "../src/config.js";
import { publicClient, vaultAbi, eventIdFor } from "../src/chain.js";
import { buildQuote } from "../src/pricer.js";
import { hedgeIfNeeded } from "../src/hedger.js";
import { vote, finalizeAndPay } from "../src/settler.js";
import { listActiveEvents, getEvent, orderedContracts, outcomeIndex, stopDepth } from "../src/gemini.js";

if (config.mockGemini || process.env.DRY_RUN === "true") throw new Error("needs MOCK_GEMINI=false and DRY_RUN unset");
config.hedgeThresholdUsdc = 0; // hedge the whole cover: this run is about the real hedge path

const USDC = "0x3600000000000000000000000000000000000000";
const erc20 = parseAbi(["function approve(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"]);
const vault = { address: config.vault, abi: vaultAbi };
const merchant = createWalletClient({ account: privateKeyToAccount(process.env.MERCHANT_PK), chain: chain(), transport: http(config.rpcUrl) });
const DEPOSIT = BigInt(Math.round(Number(process.env.LP_DEPOSIT_USDC ?? 40) * 1e6));
const PAYOUT = Number(process.env.PAYOUT_USDC ?? 5);
const txs = {};
const send = async (label, req) => {
  const hash = await merchant.writeContract(req);
  const r = await publicClient.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`${label} reverted ${hash}`);
  txs[label] = hash;
  console.log(`${label.padEnd(12)} ${hash}`);
};
const read = (functionName, args = []) => publicClient.readContract({ ...vault, functionName, args });
const asArg = (q) => ({ ...q, payout: BigInt(q.payout), premium: BigInt(q.premium), expiry: BigInt(q.expiry), eventStart: BigInt(q.eventStart), nonce: BigInt(q.nonce) });
const ask = (c) => Number(c.prices?.bestAsk);
const fromBlock = await publicClient.getBlockNumber();
process.env.FROM_BLOCK = String(fromBlock);

// 1. Sandbox stand-in: an open sandbox contract with an ask, expiring well after this run.
async function pickStandIn() {
  const r = await fetch(`${config.geminiSandboxBase}/v1/prediction-markets/events?status=active&limit=100`);
  const evs = JSON.parse(await r.text()).data ?? [];
  const soon = Date.now() + 60 * 60_000;
  for (const e of evs.sort((a, b) => Date.parse(a.expiryDate) - Date.parse(b.expiryDate))) {
    if (!(Date.parse(e.expiryDate) > soon)) continue;
    const c = (e.contracts ?? []).find((x) => x.marketState === "open" && ask(x) > 0.05 && ask(x) <= 0.6);
    if (c) return c.instrumentSymbol;
  }
  throw new Error("no open sandbox contract with an ask");
}

// 2. A real production pre-game moneyline underdog.
const events = await listActiveEvents();
const games = events
  .filter((e) => e.sportsMarket?.type === "moneyline" && !e.parentTicker && e.contracts?.length === 2 && Date.parse(e.startTime) > Date.now() + 30 * 60_000)
  .map((e) => ({ e, dog: orderedContracts(e).filter((c) => c.marketState === "open" && ask(c) > 0 && ask(c) <= 0.45).sort((a, b) => ask(a) - ask(b))[0] }))
  .filter((x) => x.dog);

console.log("merchant/LP USDC:", Number(await publicClient.readContract({ address: USDC, abi: erc20, functionName: "balanceOf", args: [merchant.account.address] })) / 1e6);
await send("approve", { address: USDC, abi: erc20, functionName: "approve", args: [config.vault, 10n ** 12n] });
await send("lpDeposit", { ...vault, functionName: "deposit", args: [DEPOSIT, merchant.account.address] });

let picked = null;
for (const { e, dog } of games.slice(0, 6)) {
  try {
    const q = await buildQuote({ eventTicker: e.ticker, instrumentSymbol: dog.instrumentSymbol, side: "YES", payoutUsdc: PAYOUT, buyer: merchant.account.address });
    await send("buyCover", { ...vault, functionName: "buyCover", args: [asArg(q.quote), q.signature] });
    picked = { e, dog, q };
    break;
  } catch (err) {
    console.log(`  ${e.ticker}: ${err.message.split("\n")[0]}`);
  }
}
if (!picked) throw new Error("no production market could be quoted");
const { e, dog, q } = picked;
console.log(`cover: $${PAYOUT} on ${dog.label} (${e.ticker}) for $${q.breakdown.premium}, p=${q.breakdown.pExec}, ${q.breakdown.bookSource}`);

const standIn = Object.keys(config.sandboxSymbolMap).length ? config.sandboxSymbolMap[dog.instrumentSymbol] : await pickStandIn();
config.sandboxSymbolMap = { ...config.sandboxSymbolMap, [dog.instrumentSymbol]: standIn };

// 3. Real sandbox hedge + recordHedge with the filled quantity and the exact Gemini order id.
const eventId = eventIdFor(e.ticker);
const hedges = await hedgeIfNeeded(eventId);
if (!hedges.length) throw new Error("hedger recorded nothing (no fill?)");
const h = hedges[0];
txs.recordHedge = h.hash;
const hedgedOnchain = Number(await read("hedged", [eventId, h.outcome])) / 1e6;
console.log(`hedge: Gemini sandbox order ${h.orderId} on ${h.venue}, filled ${h.qty}; onchain hedged = ${hedgedOnchain}`);
const logs = await publicClient.getContractEvents({ ...vault, eventName: "HedgeRecorded", args: { eventId }, fromBlock });
const onchainOrderId = logs.at(-1)?.args.geminiOrderId;
if (onchainOrderId !== h.orderId) throw new Error(`onchain order id ${onchainOrderId} != ${h.orderId}`);

// 4. Synthetic result in Gemini's settled shape -> 3/3 votes -> instant settle -> claim.
const ev = await getEvent(e.ticker);
const settled = {
  _arraSynthetic: "Arc testnet demo: the real game has not been played; result chosen for the demo",
  ...ev,
  status: "settled",
  contracts: ev.contracts.map((c) => ({ ...c, status: "settled", marketState: "closed", resolutionSide: c.instrumentSymbol === dog.instrumentSymbol ? "yes" : "no" })),
};
const winner = outcomeIndex(ev, dog.instrumentSymbol, "YES");
const before = await publicClient.readContract({ address: USDC, abi: erc20, functionName: "balanceOf", args: [merchant.account.address] });
await vote(e.ticker, winner, new TextEncoder().encode(JSON.stringify({ data: settled })));
await finalizeAndPay(e.ticker);
const got = (await publicClient.readContract({ address: USDC, abi: erc20, functionName: "balanceOf", args: [merchant.account.address] })) - before;
console.log(`payout received: ${Number(got) / 1e6} USDC`);
const voteLogs = await publicClient.getContractEvents({ ...vault, eventName: "ResultVoted", args: { eventId }, fromBlock });
voteLogs.forEach((l, i) => (txs[`vote${i + 1}`] = l.transactionHash));
const paid = await publicClient.getContractEvents({ ...vault, eventName: "CoverPaid", fromBlock });
txs.claim = paid.at(-1)?.transactionHash;

// 5. The winning hedge's proceeds are owed back from Gemini; sweep so LPs are not frozen.
const receivable = await read("hedgeReceivable");
if (receivable > 0n) await send("sweepHedge", { ...vault, functionName: "returnHedgeProceeds", args: [receivable] });
stopDepth();

const p = new URL("../../deployments/arc-testnet.json", import.meta.url);
const dep = JSON.parse(fs.readFileSync(p, "utf8"));
dep.sandboxHedgeRun = {
  at: new Date().toISOString(),
  market: { eventTicker: e.ticker, instrumentSymbol: dog.instrumentSymbol, label: dog.label, outcome: winner, payoutUsdc: PAYOUT, premiumUsdc: q.breakdown.premium, pExec: q.breakdown.pExec, bookSource: q.breakdown.bookSource },
  hedge: { venue: "Gemini sandbox", standInSymbol: h.venue, geminiOrderId: h.orderId, filledContracts: h.qty, recordedOnchainUsdc: hedgedOnchain },
  settlement: "synthetic result (real game not yet played), 3/3 votes, instant",
  txs,
};
fs.writeFileSync(p, JSON.stringify(dep, null, 2) + "\n");
console.log("saved deployments/arc-testnet.json (sandboxHedgeRun)");
if (got !== BigInt(q.quote.payout)) throw new Error("payout mismatch");
console.log("TESTNET HEDGE RUN OK");
process.exit(0);
