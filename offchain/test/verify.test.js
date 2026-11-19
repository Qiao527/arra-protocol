// Public settlement verifier + exact evidence bytes.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { keccak256 } from "viem";

process.env.MOCK_GEMINI = "false";
const { getEventRaw } = await import("../src/gemini.js");
const { verifyEvidence, saveEvidence, loadEvidence } = await import("../src/verify.js");

const ml = JSON.parse(fs.readFileSync(new URL("./fixtures/gemini-events-moneyline.json", import.meta.url), "utf8")).data[0];
const settledGame = (winnerSuffix) => {
  const { events, ...e } = structuredClone(ml);
  e.status = "settled";
  e.contracts = e.contracts.map((c) => ({ ...c, status: "settled", marketState: "closed", resolutionSide: c.instrumentSymbol.endsWith(winnerSuffix) ? "yes" : "no" }));
  return e;
};
const bytesOf = (obj) => new TextEncoder().encode(JSON.stringify({ data: obj }));

test("L-2: evidence hash is over the exact response bytes (fetch().text() strips a BOM)", async () => {
  const body = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('{"ticker":"X","contracts":[]}')]);
  const orig = globalThis.fetch;
  globalThis.fetch = async () => new Response(body, { status: 200 });
  try {
    const r = await getEventRaw("X");
    assert.equal(keccak256(r.bytes), keccak256(body));
    assert.equal(r.event.ticker, "X");
  } finally {
    globalThis.fetch = orig;
  }
});

test("verifier PASS: stored bytes hash to the onchain evidence and imply the onchain winner", () => {
  const ev = settledGame("-ARI");
  const bytes = bytesOf(ev);
  const winner = [...ev.contracts].sort((a, b) => (a.instrumentSymbol < b.instrumentSymbol ? -1 : 1)).findIndex((c) => c.instrumentSymbol.endsWith("-ARI"));
  const r = verifyEvidence({ bytes, eventTicker: ml.ticker, onchain: { state: "Settled", evidenceHash: keccak256(bytes), winningOutcome: winner } });
  assert.equal(r.pass, true, JSON.stringify(r.checks));
});

test("verifier FAIL: tampered bytes, or bytes that imply a different winner", () => {
  const ev = settledGame("-ARI");
  const bytes = bytesOf(ev);
  const tampered = bytesOf(settledGame("-SF"));
  const wrongHash = verifyEvidence({ bytes: tampered, eventTicker: ml.ticker, onchain: { state: "Settled", evidenceHash: keccak256(bytes), winningOutcome: 0 } });
  assert.equal(wrongHash.pass, false);
  assert.equal(wrongHash.checks.find((c) => c.name === "evidence hash").ok, false);
  const r = verifyEvidence({ bytes: tampered, eventTicker: ml.ticker, onchain: { state: "Settled", evidenceHash: keccak256(tampered), winningOutcome: 99 } });
  assert.equal(r.pass, false);
  assert.equal(r.checks.find((c) => c.name === "winning outcome").ok, false);
});

test("evidence is stored at vote time under its hash and loads back byte-identical", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arra-ev-"));
  const bytes = bytesOf(settledGame("-ARI"));
  const file = saveEvidence({ dir, eventTicker: ml.ticker, bytes });
  assert.ok(file.endsWith(`${keccak256(bytes)}.json`));
  assert.deepEqual(loadEvidence({ dir, eventTicker: ml.ticker, evidenceHash: keccak256(bytes) }), bytes);
  assert.equal(loadEvidence({ dir, eventTicker: ml.ticker, evidenceHash: "0x" + "00".repeat(32) }), null);
});

test("public verifier fetches attested bytes from the keeper and rejects any that don't hash to the onchain value", async () => {
  const { fetchEvidence } = await import("../src/verify.js");
  const good = bytesOf(settledGame("-ARI"));
  const h = keccak256(good);
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(url);
    return url.endsWith(`${h}.json`) ? new Response(good, { status: 200 }) : new Response("{}", { status: 200 });
  };
  const bytes = await fetchEvidence({ base: "https://keeper.example/", eventTicker: ml.ticker, evidenceHash: h, fetchImpl });
  assert.equal(keccak256(bytes), h);
  assert.equal(seen[0], `https://keeper.example/evidence/${ml.ticker}/${h}.json`);
  const other = "0x" + "11".repeat(32);
  assert.equal(await fetchEvidence({ base: "https://keeper.example", eventTicker: ml.ticker, evidenceHash: other, fetchImpl }), null);
});
