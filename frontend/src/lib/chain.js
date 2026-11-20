// Read-only access to ArraVault on Arc: contract views over JSON-RPC, history via Blockscout
// (Arc's RPC caps eth_getLogs ranges; the explorer API indexes the full history).
import { createPublicClient, http, keccak256, toBytes, decodeEventLog, decodeFunctionData, getAbiItem, toEventSelector } from "viem";
import { chain, VAULT, USDC, EXPLORER, PRICER_URL, vaultAbi, erc20Abi, RESULT_PROOFS, proofsAbi } from "./config.js";
import proofsArtifact from "../../../offchain/abi/ArraResultProofs.json";
import { checkClaim } from "./zkcheck.js";

// Multicall3 batching: dozens of view calls per page become one eth_call (Arc's public RPC rate-limits).
export const client = createPublicClient({
  chain,
  batch: { multicall: { wait: 16 } },
  transport: http(undefined, { retryCount: 4, retryDelay: 400 }),
});

const v = (functionName, args = []) => client.readContract({ address: VAULT, abi: vaultAbi, functionName, args });

export const eventIdOf = (ticker) => keccak256(toBytes(ticker));
export const units = (x) => Number(x) / 1e6;

export async function readVault() {
  const [totalAssets, totalLocked, pendingClaims, hedgeReceivable, proposedLoss, freeAssets, totalSupply, eventCapBps, balance, policyCount, settlerCount, settlerThreshold, disputeWindow] =
    await Promise.all([
      v("totalAssets"), v("totalLocked"), v("pendingClaims"), v("hedgeReceivable"), v("proposedLoss"), v("freeAssets"),
      v("totalSupply"), v("eventCapBps"),
      client.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [VAULT] }),
      v("policyCount"), v("settlerCount"), v("settlerThreshold"), v("disputeWindow"),
    ]);
  return {
    totalAssets: units(totalAssets), totalLocked: units(totalLocked), pendingClaims: units(pendingClaims),
    hedgeReceivable: units(hedgeReceivable), proposedLoss: units(proposedLoss), freeAssets: units(freeAssets),
    balance: units(balance), sharePrice: totalSupply > 0n ? Number(totalAssets) / Number(totalSupply) * 1e6 : 1,
    eventCapBps: Number(eventCapBps), policyCount: Number(policyCount),
    settlerCount: Number(settlerCount), settlerThreshold: Number(settlerThreshold), disputeWindow: Number(disputeWindow),
  };
}

export async function readPolicy(id) {
  const [holder, eventId, outcome, payout, premium, claimed] = await v("policies", [BigInt(id)]);
  return { id: Number(id), holder, eventId, outcome: Number(outcome), payout: units(payout), premium: units(premium), claimed };
}

export async function readEvent(eventId) {
  const [state, winningOutcome, eventStart, proposedAt, round, numOutcomes, evidenceHash, locked] = await v("events", [eventId]);
  const n = Number(numOutcomes);
  const idx = [...Array(n).keys()];
  const [liab, hedged, worst, insured, premiums] = await Promise.all([
    Promise.all(idx.map((i) => v("liability", [eventId, i]))),
    Promise.all(idx.map((i) => v("hedged", [eventId, i]))),
    v("worstUnhedged", [eventId]),
    v("insuredVolume", [eventId]),
    v("premiumsOf", [eventId]),
  ]);
  return {
    eventId, state: Number(state), winningOutcome: Number(winningOutcome), eventStart: Number(eventStart),
    proposedAt: Number(proposedAt), round: Number(round), numOutcomes: n, evidenceHash, locked: units(locked),
    liability: liab.map(units), hedged: hedged.map(units), worstUnhedged: units(worst), insured: units(insured), premiums: units(premiums),
  };
}

export async function readPolicies(count) {
  const ids = [...Array(count).keys()];
  return Promise.all(ids.map(readPolicy));
}

// ---------------------------------------------------------------- history (Blockscout)

const topic = (name) => toEventSelector(getAbiItem({ abi: vaultAbi, name }));

/** Logs of one vault event, optionally filtered by an indexed eventId (topic position). */
export async function vaultLogs(name, { eventId, eventIdTopic = 1 } = {}) {
  const q = new URLSearchParams({ module: "logs", action: "getLogs", fromBlock: "0", toBlock: "latest", address: VAULT, topic0: topic(name) });
  if (eventId) {
    q.set(`topic${eventIdTopic}`, eventId);
    q.set(`topic0_${eventIdTopic}_opr`, "and");
  }
  const res = await fetch(`${EXPLORER}/api?${q}`);
  const body = await res.json();
  if (!Array.isArray(body.result)) return [];
  return body.result.map((l) => {
    const decoded = decodeEventLog({ abi: vaultAbi, data: l.data, topics: l.topics.filter(Boolean) });
    return { ...decoded.args, txHash: l.transactionHash, time: Number(l.timeStamp) * 1000, block: Number(l.blockNumber) };
  });
}

/** zkTLS proof of Gemini's result for an event, if one was recorded in ArraResultProofs. */
export async function readResultProof(eventId) {
  if (!RESULT_PROOFS) return null;
  const [identifier, attestor, timestampS, winningSymbolHash] = await client.readContract({ address: RESULT_PROOFS, abi: proofsAbi, functionName: "proofOf", args: [eventId] });
  if (/^0x0+$/.test(identifier)) return null;
  return { identifier, attestor, timestampS: Number(timestampS), winningSymbolHash };
}

/**
 * Re-check a recorded proof from its transaction: the claim must be exactly a proof of the winner
 * (zkcheck.js), and its winner must be the outcome the vault settled on (from the keeper's
 * outcome list). Returns { ok: true } | { ok: false, why } | { ok: null, why } when it can't tell.
 */
export async function checkResultProof(eventId, winningOutcome) {
  const proofsAbiFull = proofsArtifact.abi ?? proofsArtifact;
  const q = new URLSearchParams({ module: "logs", action: "getLogs", fromBlock: "0", toBlock: "latest", address: RESULT_PROOFS,
    topic0: toEventSelector(getAbiItem({ abi: proofsAbiFull, name: "ResultProven" })), topic1: eventId, topic0_1_opr: "and" });
  const logs = (await (await fetch(`${EXPLORER}/api?${q}`)).json()).result;
  if (!Array.isArray(logs) || !logs.length) return { ok: null, why: "the proof transaction could not be found" };
  const tx = await client.getTransaction({ hash: logs[0].transactionHash });
  const { functionName, args } = decodeFunctionData({ abi: proofsAbiFull, data: tx.input });
  if (functionName !== "prove") return { ok: null, why: "the proof was recorded through another contract" };
  const [eventTicker, winningSymbol, claim] = args;
  if (keccak256(toBytes(eventTicker)) !== eventId) return { ok: false, why: "the proof is for another event" };
  const r = checkClaim({ eventTicker, winningSymbol, provider: claim.provider, parameters: claim.parameters });
  if (!r.ok) return r;
  const outcomes = PRICER_URL ? (await (await fetch(`${PRICER_URL}/registry`)).json())[eventId]?.outcomes : null;
  if (!outcomes) return { ok: null, why: "the outcome list is unavailable, so the winner can't be compared" };
  if (outcomes[winningOutcome] !== winningSymbol) return { ok: false, why: `it proves ${winningSymbol}, but the vault settled on another outcome` };
  return { ok: true };
}
