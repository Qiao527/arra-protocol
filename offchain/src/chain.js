import fs from "node:fs";
import { createPublicClient, createWalletClient, http, keccak256, toBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { config, chain } from "./config.js";

const artifact = JSON.parse(
  fs.readFileSync(new URL("../../out/ArraVault.sol/ArraVault.json", import.meta.url), "utf8")
);
export const vaultAbi = artifact.abi;

export const publicClient = createPublicClient({ chain: chain(), transport: http(config.rpcUrl) });

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
  const [ev, ta, cap] = await Promise.all([r("events", [eventId]), r("totalAssets"), r("eventCapBps")]);
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
