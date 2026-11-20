// node --test frontend/src/lib/zkcheck.test.js
// ArraResultProofs only checks that the expected URL and regex appear *somewhere* in a claim's
// parameters. These are claims it accepts that do not prove the winner; the page must reject them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkClaim, winnerRegex } from "./zkcheck.js";

const T = "NFL-2611200115-IND-HOU-M";
const W = "GEMI-NFL-2611200115-IND-HOU-M-HOU";
const URL = `https://api.gemini.com/v1/prediction-markets/events/${T}`;
const params = (o) => JSON.stringify({ body: "", method: "GET", responseMatches: [{ type: "regex", value: winnerRegex(W) }], responseRedactions: [], url: URL, ...o });
const claim = (o) => ({ eventTicker: T, winningSymbol: W, provider: "http", parameters: params(o) });

// The real proof recorded on Arc (test/fixtures/reclaim-xrp-proof.json), byte for byte.
const REAL = {
  eventTicker: "XRP2611200200",
  winningSymbol: "GEMI-XRP2611200200-HI0D88",
  provider: "http",
  parameters:
    '{"body":"","headers":{"User-Agent":"reclaim/0.0.1","accept":"application/json"},"method":"GET","responseMatches":[{"type":"regex","value":"\\"instrumentSymbol\\":\\"GEMI-XRP2611200200-HI0D88\\"[^{}]*?\\"resolutionSide\\":\\"yes\\""}],"responseRedactions":[],"url":"https://api.gemini.com/v1/prediction-markets/events/XRP2611200200"}',
};

test("the real recorded proof passes", () => {
  assert.deepEqual(checkClaim(REAL), { ok: true });
  assert.equal(checkClaim(claim()).ok, true);
});

test("a regex with an extra branch (matches any Gemini response) fails", () => {
  const r = checkClaim(claim({ responseMatches: [{ type: "regex", value: `${winnerRegex(W)}|"ticker"` }] }));
  assert.equal(r.ok, false);
});

test("an inverted match (proves the pattern is absent) fails", () => {
  assert.equal(checkClaim(claim({ responseMatches: [{ invert: true, type: "regex", value: winnerRegex(W) }] })).ok, false);
});

test("a request to another host, with Gemini's URL only in a header, fails", () => {
  assert.equal(checkClaim(claim({ headers: { url: URL }, url: "https://attacker.example/fake" })).ok, false);
});

test("a redacted response fails (redaction can splice parts of different contracts)", () => {
  assert.equal(checkClaim(claim({ responseRedactions: [{ jsonPath: "$.contracts[0]" }] })).ok, false);
});

test("a proof for another event or a non-http provider fails", () => {
  assert.equal(checkClaim({ ...claim(), eventTicker: "NFL-2611221800-ARI-KC-M" }).ok, false);
  assert.equal(checkClaim({ ...claim(), provider: "https" }).ok, false);
  assert.equal(checkClaim({ ...claim(), parameters: "not json" }).ok, false);
});
