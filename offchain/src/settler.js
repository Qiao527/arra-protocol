// Settler: attests Gemini's result onchain, then finalizes after the dispute window and
// pushes USDC to every winning cover.
//
// Settlement is a quorum: each settler key votes (outcome + keccak256 of the raw Gemini
// settlement response as evidence). Once `settlerThreshold` matching votes land, the vault
// opens a dispute window during which the guardian can veto. After it, anyone finalizes.
//
//   node src/settler.js watch                         poll Gemini for settled events we sold cover on
//   node src/settler.js settle <eventTicker> <outcome>  demo: outcome = index, or YES/NO on single-contract events
//
// In production each settler is an independent operator with its own key and its own Gemini
// fetch; SETTLER_PRIVATE_KEYS holding several keys in one process is a demo convenience.
import { keccak256, toBytes } from "viem";
import { config } from "./config.js";
import { getEventRaw, orderedContracts } from "./gemini.js";
import { publicClient, settlerWallets, operatorWallet, vaultAbi, eventIdFor } from "./chain.js";
import { readRegistry } from "./registry.js";

const vault = { address: config.vault, abi: vaultAbi };
const STATE = ["None", "Open", "Proposed", "Settled"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Which outcome index won, from a settled Gemini event. null if not settled yet. */
export function settledOutcome(event) {
  const contracts = orderedContracts(event); // same canonical order as the pricer
  const sides = contracts.map(contractSide);
  if (sides.some((x) => x === null)) return null;
  if (contracts.length === 1) return sides[0] === "YES" ? 0 : 1;
  const i = sides.indexOf("YES");
  return i >= 0 ? i : null;
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

const parseOutcome = (o) => (o === "YES" ? 0 : o === "NO" ? 1 : Number(o));

/** Each configured settler votes. Unanimous -> settled instantly; threshold -> dispute window. */
export async function vote(eventTicker, outcomeArg, evidence) {
  const eventId = eventIdFor(eventTicker);
  const outcome = parseOutcome(outcomeArg);
  if (!Number.isInteger(outcome) || outcome < 0 || outcome > 15) throw new Error("bad outcome");
  const evidenceHash = keccak256(toBytes(evidence));
  const threshold = Number(await publicClient.readContract({ ...vault, functionName: "settlerThreshold" }));

  for (const w of settlerWallets()) {
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

  const logs = await publicClient.getContractEvents({
    ...vault,
    eventName: "CoverPurchased",
    args: { eventId },
    fromBlock: BigInt(process.env.FROM_BLOCK ?? 0),
  });
  const w = operatorWallet();
  for (const log of logs) {
    if (Number(log.args.outcome) !== done.winning) continue;
    const id = log.args.policyId;
    const p = await publicClient.readContract({ ...vault, functionName: "policies", args: [id] });
    if (p[5]) continue; // already claimed
    const tx = await w.writeContract({ ...vault, functionName: "claim", args: [id] });
    await publicClient.waitForTransactionReceipt({ hash: tx });
    console.log(`paid policy #${id}: ${Number(p[3]) / 1e6} USDC -> ${p[0]}  tx ${tx}`);
  }
}

/** Demo / manual: full settlement with a synthetic evidence string. */
export async function settle(eventTicker, outcome, evidence) {
  const ev = evidence ?? JSON.stringify({ source: "manual-demo", eventTicker, outcome, at: new Date().toISOString() });
  await vote(eventTicker, outcome, ev);
  await finalizeAndPay(eventTicker);
}

async function watch() {
  console.log("Settler watching Gemini for settled markets...");
  for (;;) {
    for (const [eventId, info] of Object.entries(readRegistry())) {
      try {
        const st = await eventState(eventId);
        if (st.state === "Proposed") {
          await finalizeAndPay(info.eventTicker);
          continue;
        }
        if (st.state !== "Open") continue;
        const { event, raw } = await getEventRaw(info.eventTicker);
        const outcome = settledOutcome(event);
        if (outcome !== null) {
          await vote(info.eventTicker, outcome, raw); // evidence = keccak256 of the exact Gemini response bytes
          await finalizeAndPay(info.eventTicker);
        }
      } catch (err) {
        console.error(`settler: ${info.eventTicker}: ${err.message}`);
      }
    }
    await sleep(30_000);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, sym, side] = process.argv.slice(2);
  if (cmd === "settle") await settle(sym, (side ?? "").toUpperCase());  // sym = event ticker
  else await watch();
}
