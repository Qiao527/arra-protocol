// Settler: attests Gemini's result onchain, then finalizes after the dispute window and
// pushes USDC to every winning cover.
//
// Settlement is a quorum: each settler key votes (outcome + keccak256 of the raw Gemini
// settlement response as evidence). Once `settlerThreshold` matching votes land, the vault
// opens a dispute window during which the guardian can veto. After it, anyone finalizes.
//
//   node src/settler.js watch                         poll Gemini for settled events we sold cover on
//   node src/settler.js settle <eventTicker> <outcome>  demo: outcome = index, YES/NO on single-contract events, or VOID
//
// In production each settler is an independent operator with its own key and its own Gemini
// fetch; SETTLER_PRIVATE_KEYS holding several keys in one process is a demo convenience.
import { zkEnabled, proveResult, recordProof } from "./zkproof.js";
import { keccak256, toBytes } from "viem";
import { config } from "./config.js";
import { getEventRaw, orderedContracts, outcomeSymbols, MAX_OUTCOMES } from "./gemini.js";
import { publicClient, settlerWallets, operatorWallet, vaultAbi, eventIdFor, getLogsChunked } from "./chain.js";
import { readRegistry } from "./registry.js";

const vault = { address: config.vault, abi: vaultAbi };
const STATE = ["None", "Open", "Proposed", "Settled"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** ArraVault.VOID_OUTCOME: no contract won (tie without a draw contract, cancellation). Premiums are refunded. */
export const VOID_OUTCOME = 255;

/**
 * Which outcome index won, from a settled Gemini event. null if not settled yet or ambiguous.
 *   - every contract must be settled (a partially settled event never settles)
 *   - single-contract binary event: YES = 0, NO = 1
 *   - multi-contract event: exactly one YES wins; no YES at all = VOID; more than one YES is
 *     contradictory evidence, so no vote (a human must look)
 */
export function settledOutcome(event, pinned) {
  const contracts = orderedContracts(event); // same canonical order as the pricer
  const sides = contracts.map(contractSide);
  if (!sides.length || sides.some((x) => x === null)) return null;
  if (contracts.length === 1 && !(pinned?.length > 1)) return sides[0] === "YES" ? 0 : 1;
  // Indexes sold are pinned at first sale; a pinned contract that vanished needs a human.
  const listed = new Set(contracts.map((c) => c.instrumentSymbol));
  if (pinned?.some((s) => !listed.has(s))) return null;
  const side = new Map(contracts.map((c, i) => [c.instrumentSymbol, sides[i]]));
  const order = outcomeSymbols(event, pinned);
  const yes = order.flatMap((s, i) => (side.get(s) === "YES" ? [i] : []));
  if (yes.length === 0) return VOID_OUTCOME;
  return yes.length === 1 ? yes[0] : null;
}

/**
 * How many settler keys vote. A result normally gets every key (unanimous settles instantly).
 * A VOID inferred from Gemini (no contract won) stops at the threshold, so it always goes
 * through the dispute window and the guardian can look before premiums are refunded.
 */
export const votesToCast = ({ outcome, threshold, wallets }) => (outcome === VOID_OUTCOME ? Math.min(threshold, wallets) : wallets);

/** Outcome indexes the vault accepts: 0..MAX_OUTCOMES-1, or VOID_OUTCOME. */
export function checkVoteOutcome(o) {
  if (Number.isInteger(o) && ((o >= 0 && o < MAX_OUTCOMES) || o === VOID_OUTCOME)) return o;
  throw new Error(`bad outcome ${o}`);
}

/** Try to read a settled side (YES/NO) from a Gemini contract. Returns null if not settled. */
export function contractSide(contract) {
  const status = String(contract.status ?? "").toLowerCase();
  if (!["settled", "resolved", "finalized", "closed"].includes(status)) return null;
  const r = contract.resolutionSide ?? contract.resolution ?? contract.result ?? contract.outcome ?? contract.settlementValue;
  if (r == null) return null;
  const v = String(r).toLowerCase();
  if (["yes", "1", "true"].includes(v)) return "YES";
  if (["no", "0", "false"].includes(v)) return "NO";
  return null;
}

async function eventState(eventId) {
  const e = await publicClient.readContract({ ...vault, functionName: "events", args: [eventId] });
  // [state, winningOutcome, eventStart, proposedAt, round, numOutcomes, evidenceHash, locked]
  return { state: STATE[Number(e[0])], winning: Number(e[1]), proposedAt: Number(e[3]), evidenceHash: e[6] };
}

const parseOutcome = (o) => (o === "YES" ? 0 : o === "NO" ? 1 : o === "VOID" ? VOID_OUTCOME : Number(o));

/** Each configured settler votes. Unanimous -> settled instantly; threshold -> dispute window. */
export async function vote(eventTicker, outcomeArg, evidence) {
  const eventId = eventIdFor(eventTicker);
  const outcome = checkVoteOutcome(parseOutcome(outcomeArg));
  const bytes = typeof evidence === "string" ? toBytes(evidence) : evidence; // exact bytes when given
  const evidenceHash = keccak256(bytes);
  // Keep the attested bytes: a later re-fetch from Gemini will not hash the same.
  const { saveEvidence } = await import("./verify.js");
  console.log(`evidence stored: ${saveEvidence({ dir: process.env.EVIDENCE_DIR, eventTicker, bytes })}`);
  const threshold = Number(await publicClient.readContract({ ...vault, functionName: "settlerThreshold" }));

  const wallets = settlerWallets();
  for (const w of wallets.slice(0, votesToCast({ outcome, threshold, wallets: wallets.length }))) {
    const st = await eventState(eventId);
    if (st.state !== "Open" && st.state !== "Proposed") break;
    const hash = await w.writeContract({ ...vault, functionName: "voteResult", args: [eventId, outcome, evidenceHash] });
    await publicClient.waitForTransactionReceipt({ hash });
    console.log(`vote outcome ${outcome} by ${w.account.address.slice(0, 10)}…  tx ${hash}`);
  }
  const st = await eventState(eventId);
  console.log(`state: ${st.state} (threshold ${threshold}), evidence ${evidenceHash.slice(0, 14)}…`);
  return { eventId, evidenceHash, state: st.state };
}

/** Wait out the dispute window, finalize, and push payouts to winners. */
export async function finalizeAndPay(eventTicker) {
  const eventId = eventIdFor(eventTicker);
  const st = await eventState(eventId);
  if (st.state === "Proposed") {
    const window = Number(await publicClient.readContract({ ...vault, functionName: "disputeWindow" }));
    for (;;) {
      const block = await publicClient.getBlock();
      const now = Math.max(Number(block.timestamp), Math.floor(Date.now() / 1000)); // dev chains only mine on tx
      const wait = st.proposedAt + window - now + 1;
      if (wait <= 0) break;
      console.log(`dispute window: ${wait}s left (guardian can veto)`);
      await sleep(Math.min(wait, 10) * 1000);
    }
    const w = operatorWallet(); // anyone can finalize
    const hash = await w.writeContract({ ...vault, functionName: "finalize", args: [eventId] });
    await publicClient.waitForTransactionReceipt({ hash });
    console.log(`finalized  tx ${hash}`);
  }

  const done = await eventState(eventId);
  if (done.state !== "Settled") throw new Error(`event is ${done.state}, not Settled`);

  const logs = await getLogsChunked(publicClient, { ...vault, eventName: "CoverPurchased", args: { eventId } }, { fromBlock: BigInt(process.env.FROM_BLOCK ?? 0) });
  const w = operatorWallet();
  let paid = 0;
  for (const log of logs) {
    // Void: every holder gets their premium back. Otherwise only the winning outcome is paid.
    if (done.winning !== VOID_OUTCOME && Number(log.args.outcome) !== done.winning) continue;
    const id = log.args.policyId;
    const p = await publicClient.readContract({ ...vault, functionName: "policies", args: [id] });
    if (p[5]) continue; // already claimed
    const tx = await w.writeContract({ ...vault, functionName: "claim", args: [id] });
    await publicClient.waitForTransactionReceipt({ hash: tx });
    const amount = done.winning === VOID_OUTCOME ? p[4] : p[3]; // premium refund vs payout
    console.log(`${done.winning === VOID_OUTCOME ? "refunded" : "paid"} policy #${id}: ${Number(amount) / 1e6} USDC -> ${p[0]}  tx ${tx}`);
    paid++;
  }
  return paid;
}

/** Demo / manual: full settlement with a synthetic evidence string. */
export async function settle(eventTicker, outcome, evidence) {
  const ev = evidence ?? JSON.stringify({ source: "manual-demo", eventTicker, outcome, at: new Date().toISOString() });
  await vote(eventTicker, outcome, ev);
  await finalizeAndPay(eventTicker);
}

/**
 * One pass over every event we sold cover on: finalize Proposed ones whose window has passed,
 * and vote any Open event whose Gemini market has settled. Returns { acted, errors }.
 */
// Settled events whose winners have all been paid (checked once per process). A payout that failed
// after the vote, e.g. an RPC error, is retried on the next pass instead of being skipped for good.
const paidOut = new Set();

export async function settleOnce({ onAction = () => {} } = {}) {
  const acted = [];
  const errors = [];
  for (const [eventId, info] of Object.entries(readRegistry())) {
    try {
      const st = await eventState(eventId);
      if (st.state === "Proposed") {
        await finalizeAndPay(info.eventTicker);
        acted.push(info.eventTicker);
        onAction(`${info.eventTicker}: finalized and paid`);
        continue;
      }
      if (st.state === "Settled") {
        if (!paidOut.has(eventId)) {
          const n = await finalizeAndPay(info.eventTicker);
          paidOut.add(eventId);
          if (n) {
            acted.push(info.eventTicker);
            onAction(`${info.eventTicker}: paid ${n} outstanding cover${n > 1 ? "s" : ""}`);
          }
        }
        continue;
      }
      if (st.state !== "Open") continue;
      const { event, bytes } = await getEventRaw(info.eventTicker);
      const outcome = settledOutcome(event, info.outcomes);
      if (outcome !== null) {
        const { saveOutcomes } = await import("./verify.js");
        saveOutcomes({ dir: process.env.EVIDENCE_DIR, eventTicker: info.eventTicker, outcomes: info.outcomes });
        await vote(info.eventTicker, outcome, bytes); // evidence = keccak256 of the exact Gemini response bytes
        await finalizeAndPay(info.eventTicker);
        paidOut.add(eventId);
        acted.push(info.eventTicker);
        onAction(`${info.eventTicker}: Gemini settled -> outcome ${outcome === VOID_OUTCOME ? "VOID" : outcome}, voted and paid`);
        // zkTLS: prove the result came from api.gemini.com and record it onchain. Optional and
        // non-fatal: the vote above already settled the event.
        const symbol = outcome !== VOID_OUTCOME ? info.outcomes?.[outcome] : null;
        if (symbol && zkEnabled()) {
          // Awaited (not fire-and-forget) so its transaction never races the payouts from the same
          // operator account for a nonce; bounded so a slow attestor can't stall the loop.
          const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error("timed out after 120 s")), 120_000));
          try {
            const tx = await Promise.race([proveResult(info.eventTicker, symbol).then(({ doc }) => recordProof(doc)), timeout]);
            onAction(`${info.eventTicker}: zkTLS proof recorded onchain ${tx}`);
          } catch (e) {
            onAction(`${info.eventTicker}: zkTLS proof skipped (${e.message.split("\n")[0]})`);
          }
        }
      }
    } catch (err) {
      errors.push(`${info.eventTicker}: ${err.message.split("\n")[0]}`);
    }
  }
  return { acted, errors };
}

async function watch() {
  console.log("Settler watching Gemini for settled markets...");
  for (;;) {
    const { errors } = await settleOnce({ onAction: (m) => console.log(m) });
    for (const e of errors) console.error(`settler: ${e}`);
    await sleep(30_000);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, sym, side] = process.argv.slice(2);
  if (cmd === "settle") await settle(sym, (side ?? "").toUpperCase());  // sym = event ticker
  else await watch();
}
