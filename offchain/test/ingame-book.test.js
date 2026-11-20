// H-3 residual + N-7: an in-game quote must come from a book that has actually moved recently.
// A game that ends early can leave its book frozen at pre-result prices; socket liveness alone
// (N-7) doesn't show that, so each book tracks when a delta last changed it.
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.MOCK_GEMINI = "false";
const { createDepthStore } = await import("../src/depth.js");
const { checkInGameBook } = await import("../src/pricer.js");

test("a book reports when a delta last changed it; a snapshot alone is not a change", () => {
  let t = 1_000_000;
  const store = createDepthStore({ now: () => t });
  store.onFrame({ e: "depthUpdate", s: "gemi-x", U: 1, u: 1, b: [], a: [["0.2", "10"]] });
  assert.equal(store.getDepthBook("gemi-x").changedAgeMs, null);
  t += 1_000;
  store.onFrame({ e: "depthUpdate", s: "gemi-x", U: 1, u: 2, b: [], a: [["0.21", "5"]] }); // chains: U == previous u
  t += 3_000;
  assert.equal(store.getDepthBook("gemi-x").changedAgeMs, 3_000);
});

test("in-game quotes need a live book that changed within the limit", () => {
  const live = { source: "ws-depth", changedAgeMs: 10_000 };
  assert.doesNotThrow(() => checkInGameBook(live, 60_000));
  assert.throws(() => checkInGameBook({ ...live, changedAgeMs: 60_001 }, 60_000), /Sales closed/);
  assert.throws(() => checkInGameBook({ ...live, changedAgeMs: null }, 60_000), /Sales closed/);
  assert.throws(() => checkInGameBook({ source: "top-of-book+slippage" }, 60_000), /Sales closed/);
});
