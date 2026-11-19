// End-to-end on a local anvil chain with the mock Gemini books.
//   A) Single game: Austin bar buys "underdog wins" ($5k); 2-of-3 settlers vote; dispute window; paid.
//   B) Championship: 4 bars in 4 cities each insure their own team ($5k each). $20k of promises,
//      $5k locked. The hedger hedges only above retention. All 3 settlers agree -> instant payout.
// Exits non-zero on any mismatch.
import { createWalletClient, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { config, chain } from "../src/config.js";
import { publicClient, vaultAbi, eventIdFor } from "../src/chain.js";
import { buildQuote } from "../src/pricer.js";
import { hedgeIfNeeded } from "../src/hedger.js";
import { vote, finalizeAndPay } from "../src/settler.js";
import { getEvent, outcomeIndex } from "../src/gemini.js";

const erc20 = parseAbi([
  "function approve(address,uint256) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function mint(address,uint256)",
]);
const USDC = process.env.USDC_ADDRESS;
const vault = { address: config.vault, abi: vaultAbi };
const wallet = (pk) => createWalletClient({ account: privateKeyToAccount(pk), chain: chain(), transport: http(config.rpcUrl) });
const send = async (w, req) => publicClient.waitForTransactionReceipt({ hash: await w.writeContract(req) });
const read = (functionName, args = []) => publicClient.readContract({ ...vault, functionName, args });
const bal = (a) => publicClient.readContract({ address: USDC, abi: erc20, functionName: "balanceOf", args: [a] });
const fmt = (x) => (Number(x) / 1e6).toLocaleString();
const asArg = (q) => ({ ...q, payout: BigInt(q.payout), premium: BigInt(q.premium), expiry: BigInt(q.expiry), eventStart: BigInt(q.eventStart), nonce: BigInt(q.nonce) });
const fail = (m) => { console.error("FAIL:", m); process.exit(1); };

async function fund(w, amount) {
  await send(w, { address: USDC, abi: erc20, functionName: "mint", args: [w.account.address, amount] });
  await send(w, { address: USDC, abi: erc20, functionName: "approve", args: [config.vault, 2n ** 255n] });
}
async function buy(w, eventTicker, instrumentSymbol, side, payoutUsdc) {
  const q = await buildQuote({ eventTicker, instrumentSymbol, side, payoutUsdc, buyer: w.account.address });
  await send(w, { ...vault, functionName: "buyCover", args: [asArg(q.quote), q.signature] });
  return q;
}

const lp = wallet(process.env.LP_PK);
const bars = process.env.BAR_PKS.split(",").map(wallet);

// 1. LP funds the vault
await fund(lp, 100_000_000_000n);
await send(lp, { ...vault, functionName: "deposit", args: [100_000_000_000n, lp.account.address] });
console.log("1. LP deposited 100,000 USDC");
for (const b of bars) await fund(b, 10_000_000_000n);

// ---- A) Single game ------------------------------------------------------------
const qa = await buy(bars[0], "DEMO-UNDERDOG", "GEMI-DEMO-UNDERDOG", "YES", 5000);
console.log(`A1. Austin bar: "$5,000 free tab if the underdog wins" -> premium $${qa.breakdown.premium}`, qa.breakdown);
const ha = await hedgeIfNeeded(eventIdFor("DEMO-UNDERDOG"));
console.log(`A2. Hedger: ${ha.map((h) => `${h.qty} ${h.side} @ <= ${h.limit}`).join(", ") || "nothing above retention"}`);

// ---- B) Championship: 4 cities, 4 teams ------------------------------------------
const TEAMS = [["TEX", "Austin"], ["OSU", "Columbus"], ["UGA", "Athens"], ["BC", "Boston"]];
for (let i = 0; i < TEAMS.length; i++) {
  const [code, city] = TEAMS[i];
  const q = await buy(bars[i], "DEMO-CHAMP", `GEMI-DEMO-CHAMP-${code}`, "YES", 5000);
  console.log(`B${i + 1}. ${city} bar insures ${code} -> premium $${q.breakdown.premium} (capital charge $${q.breakdown.capitalCharge}) | event locked $${q.vaultAfter.lockedOnEvent}, insured $${q.vaultAfter.insuredVolume}`);
}
const champ = eventIdFor("DEMO-CHAMP");
const vol = await read("insuredVolume", [champ]);
console.log(`   championship: insured ${fmt(vol)} | locked on event ${fmt((await read("events", [champ]))[7])} | worst case ${fmt(await read("worstUnhedged", [champ]))}`);
const hb = await hedgeIfNeeded(champ);
console.log(`B5. Hedger: ${hb.map((h) => `${h.qty} ${h.instrumentSymbol} @ <= ${h.limit}`).join(", ") || "nothing above retention"} (1:1 would hedge ${fmt(vol)})`);

// ---- Settle B instantly (unanimous), A via dispute window ---------------------------
const bostonBefore = await bal(bars[3].account.address);
const champEvent = await getEvent("DEMO-CHAMP");
const bcIndex = outcomeIndex(champEvent, "GEMI-DEMO-CHAMP-BC", "YES");
// Evidence in Gemini's settled shape (synthetic result: the mock market never settles).
const settledChamp = {
  ...champEvent,
  status: "settled",
  contracts: champEvent.contracts.map(({ mockBook, ...c }) => ({
    ...c, status: "settled", marketState: "closed", resolutionSide: c.instrumentSymbol === "GEMI-DEMO-CHAMP-BC" ? "yes" : "no",
  })),
};
const champBytes = new TextEncoder().encode(JSON.stringify({ data: settledChamp }));
await vote("DEMO-CHAMP", bcIndex, champBytes);
await finalizeAndPay("DEMO-CHAMP");
// Anyone can check the attestation: stored bytes -> onchain evidenceHash -> winning outcome.
const { verifyEvidence, loadEvidence } = await import("../src/verify.js");
const ce = await read("events", [champ]);
const stored = loadEvidence({ dir: process.env.EVIDENCE_DIR, eventTicker: "DEMO-CHAMP", evidenceHash: ce[6] });
const vr = stored && verifyEvidence({ bytes: stored, eventTicker: "DEMO-CHAMP", onchain: { state: "Settled", evidenceHash: ce[6], winningOutcome: Number(ce[1]) } });
if (!vr?.pass) fail(`settlement verification: ${JSON.stringify(vr?.checks)}`);
console.log(`V1. Verifier: stored evidence hashes to the onchain evidenceHash and implies outcome ${vr.impliedOutcome} -> PASS`);
const bostonGot = (await bal(bars[3].account.address)) - bostonBefore;
console.log(`S1. Championship settled by 3-of-3 vote instantly. Boston bar received ${fmt(bostonGot)} USDC`);
if (bostonGot !== 5_000_000_000n) fail("championship payout mismatch");

const austinBefore = await bal(bars[0].account.address);
const ws = (await import("../src/chain.js")).settlerWallets();
// Only 2 of 3 vote on the single game -> dispute window, then finalize.
const { keccak256, toBytes } = await import("viem");
const ev = keccak256(toBytes(JSON.stringify({ demo: "underdog wins" })));
for (const w of ws.slice(0, 2)) {
  await publicClient.waitForTransactionReceipt({ hash: await w.writeContract({ ...vault, functionName: "voteResult", args: [eventIdFor("DEMO-UNDERDOG"), 0, ev] }) });
}
console.log("S2. Single game: 2-of-3 votes -> dispute window opened");
await finalizeAndPay("DEMO-UNDERDOG");
const austinGot = (await bal(bars[0].account.address)) - austinBefore;
console.log(`S3. Austin bar received ${fmt(austinGot)} USDC (game) | vault NAV ${fmt(await read("totalAssets"))} | hedge receivable ${fmt(await read("hedgeReceivable"))}`);
if (austinGot < 5_000_000_000n) fail("single-game payout mismatch");
if ((await read("totalLocked")) !== 0n) fail("collateral not released");
console.log("E2E OK");
