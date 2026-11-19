// Verify an Arra settlement against Gemini, with no keys:
//   node scripts/verify-settlement.js <eventTicker> [--evidence <file>] [--offline]
//
// 1. Reads the onchain result: state, winningOutcome, evidenceHash.
// 2. Takes the evidence bytes the settlers attested: --evidence <file>, else the copy stored at
//    vote time in offchain/evidence/<ticker>/<hash>.json, else a live re-fetch from Gemini.
// 3. Checks keccak256(bytes) == evidenceHash, and that those bytes imply the onchain winner in
//    the canonical outcome order (contracts sorted by instrumentSymbol).
// 4. Also re-fetches Gemini live and recomputes the winner. The live bytes almost never hash to
//    the attested value (prices, volume and timestamps change), so that hash is informational;
//    the live WINNER must still agree (skip with --offline, e.g. for a synthetic test settlement).
// Env: RPC_URL, CHAIN_ID, VAULT_ADDRESS (defaults: Arc testnet + deployments/arc-testnet.json).
import fs from "node:fs";
import { keccak256 } from "viem";

const dep = JSON.parse(fs.readFileSync(new URL("../../deployments/arc-testnet.json", import.meta.url), "utf8"));
process.env.VAULT_ADDRESS ??= dep.arraVault;

const { publicClient, vaultAbi, eventIdFor } = await import("../src/chain.js");
const { config } = await import("../src/config.js");
const { getEventRaw } = await import("../src/gemini.js");
const { settledOutcome } = await import("../src/settler.js");
const { verifyEvidence, loadEvidence, loadOutcomes, fetchEvidence, fetchOutcomes } = await import("../src/verify.js");
const keeper = process.env.KEEPER_URL ?? dep.pricerUrl; // public /evidence route

const args = process.argv.slice(2);
const ticker = args[0];
if (!ticker) {
  console.error("usage: node scripts/verify-settlement.js <eventTicker> [--evidence <file>]");
  process.exit(2);
}
const evFlag = args.indexOf("--evidence");
const evidenceFile = evFlag >= 0 ? args[evFlag + 1] : null;
const offline = args.includes("--offline");

const eventId = eventIdFor(ticker);
const e = await publicClient.readContract({ address: config.vault, abi: vaultAbi, functionName: "events", args: [eventId] });
const onchain = {
  state: ["None", "Open", "Proposed", "Settled"][Number(e[0])],
  winningOutcome: Number(e[1]),
  evidenceHash: e[6],
};
console.log(`vault ${config.vault}  event ${ticker}  id ${eventId}`);
console.log(`onchain: ${onchain.state}, winning outcome ${onchain.winningOutcome}${onchain.winningOutcome === 255 ? " (VOID)" : ""}, evidence ${onchain.evidenceHash}`);

let bytes = null;
let source = null;
if (evidenceFile) {
  bytes = new Uint8Array(fs.readFileSync(evidenceFile));
  source = evidenceFile;
} else {
  bytes = loadEvidence({ dir: process.env.EVIDENCE_DIR, eventTicker: ticker, evidenceHash: onchain.evidenceHash });
  if (bytes) source = "stored at vote time";
  if (!bytes) {
    bytes = await fetchEvidence({ base: keeper, eventTicker: ticker, evidenceHash: onchain.evidenceHash });
    if (bytes) source = `stored at vote time, fetched from ${keeper}/evidence (hash-checked)`;
  }
}

let live = null;
let liveError = null;
if (!offline) {
  try {
    live = await getEventRaw(ticker);
  } catch (err) {
    liveError = err.message;
    console.log(`live Gemini fetch failed: ${err.message}`);
  }
}
// Outcome order pinned at first sale (stored next to the evidence), else canonical order.
const outcomes = loadOutcomes({ dir: process.env.EVIDENCE_DIR, eventTicker: ticker }) ?? (await fetchOutcomes({ base: keeper, eventTicker: ticker }));
if (!bytes && live) {
  bytes = live.bytes;
  source = "live re-fetch (attested bytes not found; hash will usually differ)";
}
if (!bytes) {
  console.log("FAIL: no evidence bytes available");
  process.exit(1);
}

console.log(`evidence: ${source}, ${bytes.length} bytes`);
const r = verifyEvidence({ bytes, onchain, eventTicker: ticker, outcomes });
for (const c of r.checks) console.log(`  ${c.ok ? "PASS" : "FAIL"}  ${c.name}: ${c.detail}`);

if (liveError) {
  console.log("  FAIL  live Gemini check could not run (use --offline to skip it deliberately)");
  r.pass = false;
}
if (live) {
  const liveWinner = settledOutcome(live.event, outcomes);
  const agrees = liveWinner !== null && liveWinner === onchain.winningOutcome;
  console.log(`  ${agrees ? "PASS" : "FAIL"}  live Gemini winner: ${liveWinner ?? "not settled"} (onchain ${onchain.winningOutcome})`);
  console.log(`  info  live bytes hash ${keccak256(live.bytes)} ${keccak256(live.bytes) === onchain.evidenceHash ? "matches" : "differs (expected: responses change over time)"}`);
  r.pass = r.pass && agrees;
}
console.log(r.pass ? "PASS" : "FAIL");
process.exit(r.pass ? 0 : 1);
