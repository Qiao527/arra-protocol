import fs from "node:fs";
import { createPublicClient, createWalletClient, http, keccak256, toBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { config, chain } from "./config.js";

// ABI: ARRA_ABI_PATH, else the Foundry build output, else the committed copy (abi/, refreshed with
// `npm run abi` and checked against out/ in CI) so the services run on hosts without Foundry.
function loadAbi() {
  const candidates = [
    process.env.ARRA_ABI_PATH,
    new URL("../../out/ArraVault.sol/ArraVault.json", import.meta.url),
    new URL("../abi/ArraVault.json", import.meta.url),
  ].filter(Boolean);
  for (const f of candidates) if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, "utf8")).abi;
  throw new Error("ArraVault ABI not found: run `forge build` or `npm run abi`");
}
export const vaultAbi = loadAbi();

// Batch reads through Multicall3 where the chain has it (Arc testnet does): a quote reads ~2n+4
// values, and as separate calls a 30-team event tripped the public RPC's request limit.
const c = chain();
export const publicClient = createPublicClient({
  chain: c,
  transport: http(config.rpcUrl),
  ...(c.contracts?.multicall3 ? { batch: { multicall: true } } : {}),
});

/**
 * getContractEvents over any block range. Arc's public RPC refuses eth_getLogs over more than
 * 10,000 blocks, and the scan from FROM_BLOCK grows by ~100k blocks a day.
 */
export async function getLogsChunked(client, params, { fromBlock, toBlock, step = 10_000n }) {
  // cacheTime 0: viem caches the block number for a polling interval, which can miss logs from
  // the last few seconds (a cover bought just before settlement would go unpaid until next run)
  const end = toBlock ?? (await client.getBlockNumber({ cacheTime: 0 }));
  const logs = [];
  for (let a = BigInt(fromBlock); a <= end; a += step) {
    const b = a + step - 1n < end ? a + step - 1n : end;
    logs.push(...(await client.getContractEvents({ ...params, fromBlock: a, toBlock: b })));
  }
  return logs;
}

export function operatorAccount() {
  if (!config.operatorPk) throw new Error("OPERATOR_PRIVATE_KEY not set");
  return privateKeyToAccount(config.operatorPk);
}

export function operatorWallet() {
  return createWalletClient({ account: operatorAccount(), chain: chain(), transport: http(config.rpcUrl) });
}

/** One wallet per settler key. In production each settler is an independent operator. */
export function settlerWallets() {
  if (!config.settlerPks.length) throw new Error("SETTLER_PRIVATE_KEYS not set");
  return config.settlerPks.map((pk) =>
    createWalletClient({ account: privateKeyToAccount(pk), chain: chain(), transport: http(config.rpcUrl) })
  );
}

const vaultRef = () => ({ address: config.vault, abi: vaultAbi });

/** Current books for one event, in USDC floats. liab[i] / hedged[i] per outcome. */
export async function readEventBooks(eventId, minOutcomes = 0) {
  const v = vaultRef();
  const r = (functionName, args = []) => publicClient.readContract({ ...v, functionName, args });
  const [ev, ta, cap, prem] = await Promise.all([r("events", [eventId]), r("totalAssets"), r("eventCapBps"), r("premiumsOf", [eventId])]);
  // events() -> [state, winningOutcome, eventStart, proposedAt, round, numOutcomes, evidenceHash, locked]
  const n = Math.max(Number(ev[5]), minOutcomes);
  const idx = [...Array(n).keys()];
  const [liab, hedged] = await Promise.all([
    Promise.all(idx.map((i) => r("liability", [eventId, i]))),
    Promise.all(idx.map((i) => r("hedged", [eventId, i]))),
  ]);
  const f = (x) => Number(x) / 1e6;
  return {
    state: ["None", "Open", "Proposed", "Settled"][Number(ev[0])],
    winning: Number(ev[1]),
    proposedAt: Number(ev[3]),
    liab: liab.map(f),
    hedged: hedged.map(f),
    premiums: f(prem),
    totalAssets: f(ta),
    capBps: Number(cap),
  };
}

/** Onchain event id = keccak256 of the Gemini EVENT ticker (all its contracts are mutually exclusive). */
export const eventIdFor = (eventTicker) => keccak256(toBytes(eventTicker));

export const quoteTypes = {
  Quote: [
    { name: "eventId", type: "bytes32" },
    { name: "outcome", type: "uint8" },
    { name: "payout", type: "uint256" },
    { name: "premium", type: "uint256" },
    { name: "expiry", type: "uint64" },
    { name: "eventStart", type: "uint64" },
    { name: "buyer", type: "address" },
    { name: "nonce", type: "uint256" },
  ],
};

export const domain = () => ({
  name: "Arra",
  version: "1",
  chainId: config.chainId,
  verifyingContract: config.vault,
});
