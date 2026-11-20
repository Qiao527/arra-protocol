// Seed the demo championship: four bars, four NBA teams, $5 each, on the real Gemini market.
// Outcomes are mutually exclusive, so $20 of promises lock only $5 in the vault.
//
//   node scripts/seed-championship.js
//
// Env: RPC_URL, CHAIN_ID (Arc testnet), DEPLOYER_PK (funds the bars), optional
//      VAULT_ADDRESS / PRICER_URL (default: deployments/arc-testnet.json), TEAMS (NOP,DAL,IND,CLE),
//      PAYOUT_USDC (5), EVENT (NBAF-2627CHAMP).
// Bar wallets are generated once and kept in offchain/data/seed-bars.json (git-ignored), so a
// re-run reuses them and skips bars that already hold a cover. Keys are never printed.
import fs from "node:fs";
import { createWalletClient, http, parseAbi, formatUnits } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";

const dep = JSON.parse(fs.readFileSync(new URL("../../deployments/arc-testnet.json", import.meta.url), "utf8"));
process.env.VAULT_ADDRESS ??= dep.arraVault;
const { config, chain } = await import("../src/config.js");
const { publicClient, vaultAbi, eventIdFor, getLogsChunked } = await import("../src/chain.js");

const PRICER = (process.env.PRICER_URL ?? dep.pricerUrl ?? "").replace(/\/$/, "");
const EVENT = process.env.EVENT ?? "NBAF-2627CHAMP";
const TEAMS = (process.env.TEAMS ?? "NOP,DAL,IND,CLE").split(",").map((t) => t.trim());
const PAYOUT = Number(process.env.PAYOUT_USDC ?? 5);
const GAS_BUFFER = 50_000n; // 0.05 USDC per bar for approve + buyCover (USDC is Arc's gas token)
const USDC = dep.usdc;
const BARS_FILE = new URL("../data/seed-bars.json", import.meta.url);
if (!PRICER) throw new Error("no PRICER_URL and no pricerUrl in deployments/arc-testnet.json");
if (!process.env.DEPLOYER_PK) throw new Error("DEPLOYER_PK not set");

const erc20 = parseAbi(["function transfer(address,uint256) returns (bool)", "function approve(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)", "function allowance(address,address) view returns (uint256)"]);
const vault = { address: config.vault, abi: vaultAbi };
const wallet = (pk) => createWalletClient({ account: privateKeyToAccount(pk), chain: chain(), transport: http(config.rpcUrl) });
const send = async (w, req) => {
  const hash = await w.writeContract(req);
  const r = await publicClient.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`reverted ${hash}`);
  return hash;
};
const bal = (a) => publicClient.readContract({ address: USDC, abi: erc20, functionName: "balanceOf", args: [a] });
const read = (functionName, args = []) => publicClient.readContract({ ...vault, functionName, args });
const usd = (x) => `$${Number(formatUnits(x, 6)).toFixed(2)}`;

async function quote(team, buyer) {
  const r = await fetch(`${PRICER}/quote`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ eventTicker: EVENT, instrumentSymbol: `GEMI-${EVENT}-${team}`, side: "YES", payoutUsdc: PAYOUT, buyer }),
  });
  const q = await r.json();
  if (!r.ok) throw new Error(`pricer ${r.status} for ${team}: ${q.error}`);
  return q;
}

// 1. Bar wallets (one per team), generated once.
let bars = {};
try {
  bars = JSON.parse(fs.readFileSync(BARS_FILE, "utf8"));
} catch {}
for (const t of TEAMS) bars[t] ??= { pk: generatePrivateKey() };
fs.mkdirSync(new URL("../data/", import.meta.url), { recursive: true });
fs.writeFileSync(BARS_FILE, JSON.stringify(bars, null, 2));

const eventId = eventIdFor(EVENT);
const deployer = wallet(process.env.DEPLOYER_PK);
console.log(`pricer ${PRICER}  vault ${config.vault}  event ${EVENT}`);

// Which bars still need a cover (re-runs skip the ones already done).
// No catch: if this read fails, a re-run must stop rather than buy every bar a second cover.
const logs = await getLogsChunked(publicClient, { ...vault, eventName: "CoverPurchased", args: { eventId } }, { fromBlock: BigInt(process.env.FROM_BLOCK ?? 0) });
const covered = new Set(logs.map((l) => l.args.holder.toLowerCase()));
const todo = TEAMS.filter((t) => !covered.has(privateKeyToAccount(bars[t].pk).address.toLowerCase()));

// 2. Fund each bar with its premium plus gas, from the deployer (topping the deployer up from its
//    own LP position if its wallet is short, while keeping NAV above what a $PAYOUT cover needs).
const plan = [];
for (const t of todo) {
  const addr = privateKeyToAccount(bars[t].pk).address;
  const q = await quote(t, addr);
  const need = BigInt(q.quote.premium) + GAS_BUFFER;
  const have = await bal(addr);
  plan.push({ t, addr, fund: need > have ? need - have : 0n, premium: BigInt(q.quote.premium) });
}
const totalFund = plan.reduce((a, p) => a + p.fund, 0n) + GAS_BUFFER;
const wallet0 = await bal(deployer.account.address);
if (wallet0 < totalFund) {
  const short = totalFund - wallet0;
  const nav = await read("totalAssets");
  const capBps = await read("eventCapBps");
  const navNeeded = (BigInt(Math.round(PAYOUT * 1e6)) * 10_000n) / capBps + 1_000_000n; // + $1 margin
  if (nav - short < navNeeded) throw new Error(`deployer short ${usd(short)} and NAV cannot spare it; use https://faucet.circle.com`);
  const h = await send(deployer, { ...vault, functionName: "withdraw", args: [short, deployer.account.address, deployer.account.address] });
  console.log(`deployer topped up ${usd(short)} from its LP position  tx ${h}`);
}
for (const p of plan) {
  if (p.fund > 0n) {
    const h = await send(deployer, { address: USDC, abi: erc20, functionName: "transfer", args: [p.addr, p.fund] });
    console.log(`funded ${p.t} bar ${p.addr} with ${usd(p.fund)}  tx ${h}`);
  }
}

// 3. Each bar buys its promise with a fresh quote from the live pricer.
const asArg = (q) => ({ ...q, payout: BigInt(q.payout), premium: BigInt(q.premium), expiry: BigInt(q.expiry), eventStart: BigInt(q.eventStart), nonce: BigInt(q.nonce) });
const bought = {};
for (const { t, addr } of plan) {
  const w = wallet(bars[t].pk);
  if ((await publicClient.readContract({ address: USDC, abi: erc20, functionName: "allowance", args: [addr, config.vault] })) < 10n ** 9n) {
    await send(w, { address: USDC, abi: erc20, functionName: "approve", args: [config.vault, 10n ** 12n] });
  }
  const q = await quote(t, addr);
  const h = await send(w, { ...vault, functionName: "buyCover", args: [asArg(q.quote), q.signature] });
  bought[t] = h;
  console.log(`${t}: $${PAYOUT} promise (outcome ${q.market.outcome}, p=${q.breakdown.pExec}, ${q.breakdown.bookSource}) premium $${q.breakdown.premium}  tx ${h}`);
}

// 4. What the risk desk shows.
const ev = await read("events", [eventId]);
const insured = await read("insuredVolume", [eventId]);
console.log(`\n${EVENT}: insured ${usd(insured)} | locked ${usd(ev[7])} | worst unhedged ${usd(await read("worstUnhedged", [eventId]))} | premiums ${usd(await read("premiumsOf", [eventId]))} | vault NAV ${usd(await read("totalAssets"))}`);
const out = new URL("../../deployments/arc-testnet.json", import.meta.url);
const d = JSON.parse(fs.readFileSync(out, "utf8"));
d.demoChampionship = {
  at: new Date().toISOString(),
  eventTicker: EVENT,
  payoutUsdcEach: PAYOUT,
  bars: Object.fromEntries(TEAMS.map((t) => [t, { address: privateKeyToAccount(bars[t].pk).address, buyCoverTx: bought[t] ?? d.demoChampionship?.bars?.[t]?.buyCoverTx ?? null }])),
  insuredUsdc: Number(formatUnits(insured, 6)),
  lockedUsdc: Number(formatUnits(ev[7], 6)),
};
fs.writeFileSync(out, JSON.stringify(d, null, 2) + "\n");
console.log("saved deployments/arc-testnet.json (demoChampionship)");
process.exit(0);
