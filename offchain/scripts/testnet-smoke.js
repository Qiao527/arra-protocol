// Small live run on Arc testnet: deposit -> signed quote -> buy cover -> record hedge -> 3-of-3 vote -> paid.
// Writes tx hashes to ../deployments/arc-testnet.json
import fs from "node:fs";
import { createWalletClient, http, parseAbi, keccak256, toBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { config, chain } from "../src/config.js";
import { publicClient, vaultAbi, eventIdFor, settlerWallets, operatorWallet } from "../src/chain.js";
import { buildQuote } from "../src/pricer.js";

const USDC = "0x3600000000000000000000000000000000000000";
const erc20 = parseAbi(["function approve(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"]);
const vault = { address: config.vault, abi: vaultAbi };
const merchant = createWalletClient({ account: privateKeyToAccount(process.env.MERCHANT_PK), chain: chain(), transport: http(config.rpcUrl) });
const DEPOSIT = BigInt(Math.round(Number(process.env.SMOKE_DEPOSIT_USDC ?? 10) * 1e6));
const PAYOUT = Number(process.env.SMOKE_PAYOUT_USDC ?? 0.9); // must be <= event cap (10% of vault)
const txs = {};
const send = async (label, w, req) => {
  const hash = await w.writeContract(req);
  const r = await publicClient.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`${label} reverted ${hash}`);
  txs[label] = hash;
  console.log(`${label.padEnd(14)} ${hash}`);
};
const bal = async () => Number(await publicClient.readContract({ address: USDC, abi: erc20, functionName: "balanceOf", args: [merchant.account.address] })) / 1e6;

console.log("merchant/LP balance:", await bal(), "USDC");
await send("approve", merchant, { address: USDC, abi: erc20, functionName: "approve", args: [config.vault, 10n ** 12n] });
await send("lpDeposit", merchant, { ...vault, functionName: "deposit", args: [DEPOSIT, merchant.account.address] });

const q = await buildQuote({ eventTicker: "DEMO-UNDERDOG", instrumentSymbol: "GEMI-DEMO-UNDERDOG", side: "YES", payoutUsdc: PAYOUT, buyer: merchant.account.address });
console.log("quote:", q.breakdown.premium, `USDC premium for ${PAYOUT} USDC payout`);
const quoteArg = { ...q.quote, payout: BigInt(q.quote.payout), premium: BigInt(q.quote.premium), expiry: BigInt(q.quote.expiry), eventStart: BigInt(q.quote.eventStart), nonce: BigInt(q.quote.nonce) };
await send("buyCover", merchant, { ...vault, functionName: "buyCover", args: [quoteArg, q.signature] });

const eventId = eventIdFor("DEMO-UNDERDOG");
await send("recordHedge", operatorWallet(), { ...vault, functionName: "recordHedge", args: [eventId, 0, BigInt(Math.floor(PAYOUT * 1e6 / 2)), "demo-dry-run"] });

const evidence = keccak256(toBytes(JSON.stringify({ demo: "testnet smoke", at: new Date().toISOString() })));
const before = await bal();
const ws = settlerWallets();
for (let i = 0; i < ws.length; i++) await send(`vote${i + 1}`, ws[i], { ...vault, functionName: "voteResult", args: [eventId, 0, evidence] });
const ev = await publicClient.readContract({ ...vault, functionName: "events", args: [eventId] });
console.log("event state after 3/3 votes:", ["None", "Open", "Proposed", "Settled"][Number(ev[0])]);
const policyId = (await publicClient.readContract({ ...vault, functionName: "policyCount" })) - 1n;
await send("claim", operatorWallet(), { ...vault, functionName: "claim", args: [policyId] });
console.log(`merchant received ${(await bal() - before).toFixed(6)} USDC (minus 0 gas: claim sent by operator)`);

// Winning hedge proceeds sit at Gemini; LP withdrawals stay frozen until they are swept back
// (production: Circle Mint / CCTP). Simulate the sweep so the vault ends unfrozen.
const receivable = await publicClient.readContract({ ...vault, functionName: "hedgeReceivable" });
if (receivable > 0n) await send("sweepHedge", merchant, { ...vault, functionName: "returnHedgeProceeds", args: [receivable] });
console.log("LP withdrawable after sweep:", Number(await publicClient.readContract({ ...vault, functionName: "maxWithdraw", args: [merchant.account.address] })) / 1e6, "USDC");

fs.mkdirSync("../deployments", { recursive: true });
fs.writeFileSync("../deployments/arc-testnet.json", JSON.stringify({
  network: "Arc Testnet", chainId: 5042002,
  explorer: "https://explorer.testnet.arc.io",
  arraVault: config.vault, usdc: USDC,
  operator: operatorWallet().account.address,
  settlers: ws.map((w) => w.account.address), settlerThreshold: 2, disputeWindowSec: 60,
  smokeTest: { at: new Date().toISOString(), eventTicker: "DEMO-UNDERDOG (mock Gemini book)", policyId: Number(policyId), txs },
}, null, 2));
console.log("saved deployments/arc-testnet.json");
