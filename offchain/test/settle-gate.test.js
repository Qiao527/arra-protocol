import { test } from "node:test";
import assert from "node:assert/strict";
import { stableOutcome } from "../src/settler.js";

const MIN = 60_000;

test("votes only after Gemini shows the same result for the whole confirm window", () => {
  const id = "0xgate1";
  assert.equal(stableOutcome(id, 1, 0, 10 * MIN).ready, false);
  assert.equal(stableOutcome(id, 1, 9 * MIN, 10 * MIN).ready, false);
  assert.equal(stableOutcome(id, 1, 10 * MIN, 10 * MIN).ready, true);
});

test("a review state in between restarts the clock (settled -> under_review -> settled)", () => {
  const id = "0xgate2";
  stableOutcome(id, 0, 0, 10 * MIN);
  stableOutcome(id, null, 3 * MIN, 10 * MIN); // under_review: no settled outcome
  assert.equal(stableOutcome(id, 0, 4 * MIN, 10 * MIN).ready, false);
  assert.equal(stableOutcome(id, 0, 13 * MIN, 10 * MIN).ready, false);
  assert.equal(stableOutcome(id, 0, 14 * MIN, 10 * MIN).ready, true);
});

test("a changed result restarts the clock", () => {
  const id = "0xgate3";
  stableOutcome(id, 0, 0, 10 * MIN);
  assert.equal(stableOutcome(id, 1, 9 * MIN, 10 * MIN).ready, false);
  assert.equal(stableOutcome(id, 1, 19 * MIN, 10 * MIN).ready, true);
});

test("SETTLE_CONFIRM_SEC=0 keeps the old instant behaviour", () => {
  assert.equal(stableOutcome("0xgate4", 0, 0, 0).ready, true);
});
