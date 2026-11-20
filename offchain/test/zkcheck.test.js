import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { keccak256, toBytes } from "viem";
import { expectedParameters, checkZkProof } from "../src/zkcheck.js";
import { proveEvent } from "../src/proofs.js";

const fx = JSON.parse(fs.readFileSync(new URL("../../test/fixtures/reclaim-xrp-proof.json", import.meta.url), "utf8"));
const realParams = fx.proof.claimData.parameters;
const ATTESTOR = "0x244897572368Eadf65bfBc5aec98D8e5443a9072";
const T = fx.eventTicker;
const WIN = fx.winningSymbol;
const outcomes = ["GEMI-OTHER", WIN];

const good = (over = {}) => ({
  eventTicker: T,
  outcomes,
  winningOutcome: 1,
  proof: { identifier: "0x" + "11".repeat(32), attestor: ATTESTOR, timestampS: 1, winningSymbolHash: keccak256(toBytes(WIN)) },
  call: { args: [T, WIN, { provider: "http", parameters: realParams }, "0x"] },
  trustedAttestors: [ATTESTOR],
  ...over,
});

test("JS expectedParameters equals the real Reclaim claim bytes (same as the contract)", () => {
  assert.equal(expectedParameters(T, WIN), realParams);
});

test("a recorded proof of the onchain winner passes", () => {
  assert.equal(checkZkProof(good()).pass, true);
});

test("zk proof fails when it names a different winner than the vault settled", () => {
  assert.equal(checkZkProof(good({ winningOutcome: 0 })).pass, false);
});

test("zk proof fails for altered parameters, other event, or untrusted attestor", () => {
  const forged = realParams.replace('\\"yes\\"', '\\"yes\\"|x');
  assert.equal(checkZkProof(good({ call: { args: [T, WIN, { provider: "http", parameters: forged }, "0x"] } })).pass, false);
  assert.equal(checkZkProof(good({ eventTicker: "OTHER" })).pass, false);
  assert.equal(checkZkProof(good({ trustedAttestors: ["0x0000000000000000000000000000000000000001"] })).pass, false);
  assert.equal(checkZkProof(good({ call: null })).pass, false);
});

const settled = { state: "Settled", winningOutcome: 1, evidenceHash: "0x" + "ab".repeat(32) };
const live = async () => ({
  ticker: T,
  status: "settled",
  contracts: outcomes.map((s) => ({ instrumentSymbol: s, status: "settled", marketState: "closed", resolutionSide: s === WIN ? "yes" : "no" })),
});

test("missing evidence bytes + valid zk proof + Gemini agrees => PASS (zk-proof)", async () => {
  const r = await proveEvent({ eventTicker: T, onchain: settled, outcomes, loadBytes: async () => null, getLive: live, loadZk: async () => checkZkProof(good()) });
  assert.equal(r.evidence, "zk-proof");
  assert.equal(r.verdict, "PASS");
});

test("missing evidence bytes and no zk proof => FAIL missing", async () => {
  const r = await proveEvent({ eventTicker: T, onchain: settled, outcomes, loadBytes: async () => null, getLive: live, loadZk: async () => null });
  assert.equal(r.verdict, "FAIL");
  assert.equal(r.evidence, "missing");
});

test("missing evidence bytes and a bad zk proof => FAIL", async () => {
  const r = await proveEvent({ eventTicker: T, onchain: settled, outcomes, loadBytes: async () => null, getLive: live, loadZk: async () => checkZkProof(good({ winningOutcome: 0 })) });
  assert.equal(r.verdict, "FAIL");
});
