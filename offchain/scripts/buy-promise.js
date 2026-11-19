// Buy one promise on Arc testnet through the live pricer, from a named demo bar wallet.
//   node scripts/buy-promise.js <eventTicker> <instrumentSymbol> <payoutUsdc> <barName>
// The bar wallet is created once and kept in offchain/data/seed-bars.json (git-ignored). The
// deployer funds it with premium + gas, topping itself up from its own LP position only while
// vault NAV stays above what a cover of this size needs under the per-event cap.
// Env: RPC_URL, CHAIN_ID, DEPLOYER_PK; optional VAULT_ADDRESS / PRICER_URL (default: deployments).
import fs from "node:fs";
import { createWalletClient, http, parseAbi, formatUnits } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";

const dep = JSON.parse(fs.readFileSync(new URL("../../deployments/arc-testnet.json", import.meta.url), "utf8"));
process.env.VAULT_ADDRESS ??= dep.arraVault;
const { config, chain } = await import("../src/config.js");
const { publicClient, vaultAbi, eventIdFor } = await import("../src/chain.js");

const [eventTicker, instrumentSymbol, payoutArg, barName] = process.argv.slice(2);
if (!barName) throw new Error("usage: buy-promise.js <eventTicker> <instrumentSymbol> <payoutUsdc> <barName>");
const PAYOUT = Number(payoutArg);
const PRICER = (process.env.PRICER_URL ?? dep.pricerUrl).replace(/\/$/, "");
const USDC = dep.usdc;
const GAS = 50_000n;
const erc20 = parseAbi(["function transfer(address,uint256) returns (bool)", "function approve(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)", "function allowance(address,address) view returns (uint256)"]);
const vault = { address: config.vault, abi: vaultAbi };
const wallet = (pk) => createWalletClient({ account: privateKeyToAccount(pk), chain: chain(), transport: http(config.rpcUrl) });
const send = async (w, req) => {
  const hash = await w.writeContract(req);
  if ((await publicClient.waitForTransactionReceipt({ hash })).status !== "success") throw new Error(`reverted ${hash}`);
  return hash;
};
const bal = (a) => publicClient.readContract({ address: USDC, abi: erc20, functionName: "balanceOf", args: [a] });
const read = (functionName, args = []) => publicClient.readContract({ ...vault, functionName, args });
const usd = (x) => `$${Number(formatUnits(x, 6)).toFixed(2)}`;
async function quote(buyer) {
  const r = await fetch(`${PRICER}/quote`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ eventTicker, instrumentSymbol, side: "YES", payoutUsdc: PAYOUT, buyer }) });
  const q = await r.json();
  if (!r.ok) throw new Error(`pricer ${r.status}: ${q.error}`);
  return q;
}

const file = new URL("../data/seed-bars.json", import.meta.url);
let bars = {};
try {
  bars = JSON.parse(fs.readFileSync(file, "utf8"));
} catch {}
bars[barName] ??= { pk: generatePrivateKey() };
fs.mkdirSync(new URL("../data/", import.meta.url), { recursive: true });
fs.writeFileSync(file, JSON.stringify(bars, null, 2));
const bar = wallet(bars[barName].pk);
const deployer = wallet(process.env.DEPLOYER_PK);

const first = await quote(bar.account.address);
const need = BigInt(first.quote.premium) + GAS;
const have = await bal(bar.account.address);
if (have < need) {
  const fund = need - have;
  const wbal = await bal(deployer.account.address);
  if (wbal < fund + GAS) {
    const short = fund + GAS - wbal;
    const nav = await read("totalAssets");
    const navNeeded = (BigInt(Math.round(PAYOUT * 1e6)) * 10_000n) / (await read("eventCapBps")) + 1_000_000n;
    if (nav - short < navNeeded) throw new Error(`deployer short ${usd(short)} and NAV cannot spare it; top up at https://faucet.circle.com`);
    console.log(`deployer tops up ${usd(short)} from its LP position  tx ${await send(deployer, { ...vault, functionName: "withdraw", args: [short, deployer.account.address, deployer.account.address] })}`);
  }
  console.log(`funded ${barName} ${bar.account.address} with ${usd(fund)}  tx ${await send(deployer, { address: USDC, abi: erc20, functionName: "transfer", args: [bar.account.address, fund] })}`);
}
if ((await publicClient.readContract({ address: USDC, abi: erc20, functionName: "allowance", args: [bar.account.address, config.vault] })) < 10n ** 9n) {
  await send(bar, { address: USDC, abi: erc20, functionName: "approve", args: [config.vault, 10n ** 12n] });
}
const q = await quote(bar.account.address);
const a = q.quote;
const hash = await send(bar, {
  ...vault,
  functionName: "buyCover",
  args: [{ ...a, payout: BigInt(a.payout), premium: BigInt(a.premium), expiry: BigInt(a.expiry), eventStart: BigInt(a.eventStart), nonce: BigInt(a.nonce) }, q.signature],
});
const policyId = Number(await read("policyCount")) - 1;
console.log(`${barName}: $${PAYOUT} on ${q.market.contract} (${eventTicker}, outcome ${q.market.outcome}, ${q.market.mode}, p=${q.breakdown.pExec}, ${q.breakdown.bookSource}) premium $${q.breakdown.premium}  policy #${policyId}  tx ${hash}`);
console.log(`event: insured ${usd(await read("insuredVolume", [eventIdFor(eventTicker)]))}, locked ${usd((await read("events", [eventIdFor(eventTicker)]))[7])}; vault NAV ${usd(await read("totalAssets"))}`);
process.exit(0);
