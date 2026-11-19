// Proof check for one event, from first principles: the onchain result, the bytes the settlers
// attested (hash-checked against the onchain evidenceHash), and Gemini's live result.
//
// Verdicts:
//   PASS       evidence checks out and Gemini's live result agrees with the onchain winner
//   FAIL       evidence missing/tampered/wrong event/wrong winner, or Gemini now disagrees
//   SYNTHETIC  evidence checks out but was marked synthetic (testnet demo; Gemini hasn't settled)
//   UNCHECKED  evidence checks out but Gemini could not be reached this run
//   UNCONFIRMED evidence checks out but Gemini does not show a result yet
//   PENDING    the event is not settled onchain yet
import { verifyEvidence, parseEvent } from "./verify.js";
import { settledOutcome } from "./settler.js";

export async function proveEvent({ eventTicker, onchain, outcomes, loadBytes, getLive }) {
  const base = { eventTicker, state: onchain.state, winningOutcome: onchain.winningOutcome ?? null, evidenceHash: onchain.evidenceHash ?? null };
  if (onchain.state !== "Settled") return { ...base, verdict: "PENDING", evidence: null, live: null, synthetic: false, checks: [] };

  // VOID by the guardian carries no evidence (evidenceHash 0): nothing to check against Gemini.
  if (onchain.winningOutcome === 255 && /^0x0+$/.test(String(onchain.evidenceHash))) {
    return { ...base, verdict: "PASS", evidence: "guardian void (no evidence by design)", live: null, synthetic: false, checks: [] };
  }

  const bytes = await loadBytes().catch(() => null);
  if (!bytes) return { ...base, verdict: "FAIL", evidence: "missing", live: null, synthetic: false, checks: [] };
  const v = verifyEvidence({ bytes, onchain, eventTicker, outcomes });
  let synthetic = false;
  try {
    synthetic = Boolean(parseEvent(bytes)?._arraSynthetic);
  } catch {}
  if (!v.pass) return { ...base, verdict: "FAIL", evidence: "bad", live: null, synthetic, checks: v.checks };

  let live;
  try {
    const now = settledOutcome(await getLive(), outcomes);
    live = now === null ? "not-settled" : now === Number(onchain.winningOutcome) ? "agrees" : "disagrees";
  } catch {
    live = "unreachable";
  }
  const verdict =
    live === "agrees" ? "PASS" : live === "disagrees" ? "FAIL" : live === "unreachable" ? "UNCHECKED" : synthetic ? "SYNTHETIC" : "UNCONFIRMED";
  return { ...base, verdict, evidence: "ok", live, synthetic, checks: v.checks };
}
