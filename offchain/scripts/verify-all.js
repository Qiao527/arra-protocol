// Re-check every event the vault sold cover on, using only public inputs: the chain, the keeper's
// /registry and hash-checked /evidence, and Gemini's live API. Runs on a schedule in GitHub Actions
// (.github/workflows/proofs.yml), independently of the keeper that did the settling.
//   node scripts/verify-all.js [--out proofs.json]
// Env: KEEPER_URL (default: deployments pricerUrl), RPC_URL/CHAIN_ID (default Arc testnet),
//      PUBLISH=true + GITHUB_EVIDENCE_TOKEN to publish the result to the keeper-data branch.
// Exit code 1 if any settled event FAILs.
import fs from "node:fs";

const dep = JSON.parse(fs.readFileSync(new URL("../../deployments/arc-testnet.json", import.meta.url), "utf8"));
process.env.VAULT_ADDRESS ??= dep.arraVault;
const { config } = await import("../src/config.js");
const { publicClient, vaultAbi } = await import("../src/chain.js");
const { getEvent } = await import("../src/gemini.js");
const { fetchEvidence } = await import("../src/verify.js");
const { proveEvent } = await import("../src/proofs.js");
const { createStore } = await import("../src/store.js");

const KEEPER = (process.env.KEEPER_URL ?? dep.pricerUrl).replace(/\/$/, "");
const STATE = ["None", "Open", "Proposed", "Settled"];
const vault = { address: config.vault, abi: vaultAbi };
const read = (functionName, args = []) => publicClient.readContract({ ...vault, functionName, args });
const usd = (x) => Number(x) / 1e6;

const registry = await (await fetch(`${KEEPER}/registry`)).json();
const events = [];
for (const [eventId, info] of Object.entries(registry)) {
  const e = await read("events", [eventId]);
  const onchain = { state: STATE[Number(e[0])], winningOutcome: Number(e[1]), evidenceHash: e[6] };
  const r = await proveEvent({
    eventTicker: info.eventTicker,
    onchain,
    outcomes: info.outcomes ?? undefined,
    loadBytes: () => fetchEvidence({ base: KEEPER, eventTicker: info.eventTicker, evidenceHash: onchain.evidenceHash }),
    getLive: () => getEvent(info.eventTicker),
  });
  events.push({
    eventId,
    title: info.title ?? null,
    ...r,
    insuredUsdc: usd(await read("insuredVolume", [eventId])),
    lockedUsdc: usd(e[7]),
    checks: r.checks.map((c) => ({ name: c.name, ok: c.ok })),
  });
}

const balance = await publicClient.readContract({ address: dep.usdc, abi: [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }], functionName: "balanceOf", args: [config.vault] });
const [locked, pending] = await Promise.all([read("totalLocked"), read("pendingClaims")]);
const runUrl = process.env.GITHUB_RUN_ID ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : null;
const report = {
  generatedAt: new Date().toISOString(),
  vault: config.vault,
  chainId: config.chainId,
  keeper: KEEPER,
  runUrl,
  solvency: { usdcHeld: usd(balance), locked: usd(locked), owed: usd(pending), ok: balance >= locked + pending },
  summary: Object.fromEntries(["PASS", "FAIL", "SYNTHETIC", "UNCHECKED", "UNCONFIRMED", "PENDING"].map((v) => [v, events.filter((e) => e.verdict === v).length])),
  events,
};

const json = JSON.stringify(report, null, 2) + "\n";
const outFlag = process.argv.indexOf("--out");
if (outFlag >= 0) fs.writeFileSync(process.argv[outFlag + 1], json);
for (const e of events) console.log(`${e.verdict.padEnd(11)} ${e.eventTicker}  state ${e.state}  evidence ${e.evidence ?? "-"}  gemini ${e.live ?? "-"}`);
console.log(`solvency: held $${report.solvency.usdcHeld} >= locked $${report.solvency.locked} + owed $${report.solvency.owed}: ${report.solvency.ok ? "OK" : "BROKEN"}`);

if (process.env.GITHUB_STEP_SUMMARY) {
  const rows = events.map((e) => `| ${e.verdict} | \`${e.eventTicker}\` | ${e.state} | ${e.evidence ?? "-"} | ${e.live ?? "-"} | $${e.insuredUsdc} / $${e.lockedUsdc} |`).join("\n");
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Arra proofs\n\nVault \`${config.vault}\`, ${report.generatedAt}\n\n| Verdict | Event | State | Evidence | Gemini now | Insured / locked |\n|---|---|---|---|---|---|\n${rows}\n\nSolvency: held $${report.solvency.usdcHeld} vs locked $${report.solvency.locked} + owed $${report.solvency.owed}: **${report.solvency.ok ? "OK" : "BROKEN"}**\n`);
}

if (process.env.PUBLISH === "true") {
  const store = createStore({ token: process.env.GITHUB_EVIDENCE_TOKEN, repo: process.env.KEEPER_REPO ?? "Qiao527/arra-protocol", branch: "keeper-data" });
  console.log("published:", await store.put("offchain/proofs/arc-testnet.json", new TextEncoder().encode(json), "proofs: scheduled verification run"));
}
process.exit(report.summary.FAIL > 0 || !report.solvency.ok ? 1 : 0);
