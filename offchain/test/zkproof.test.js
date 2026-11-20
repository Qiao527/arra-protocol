import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { winnerRegex, eventUrl } from "../src/zkproof.js";

const raw = fs.readFileSync(new URL("./fixtures/gemini-event-settled.json", import.meta.url), "utf8");

test("winner regex matches only the contract Gemini resolved YES", () => {
  const ev = JSON.parse(raw).data ?? JSON.parse(raw);
  for (const c of ev.contracts) {
    const hit = new RegExp(winnerRegex(c.instrumentSymbol)).test(raw);
    assert.equal(hit, c.resolutionSide === "yes", c.instrumentSymbol);
  }
});

test("a symbol that is a prefix of another does not borrow its YES", () => {
  // the closing quote after the symbol is part of the pattern
  assert.equal(new RegExp(winnerRegex("GEMI-XRP2611200200-HI0D8")).test(raw), false);
});

test("proof URL is Gemini's public event endpoint", () => {
  assert.equal(eventUrl("NFL-2611200115-IND-HOU-M"), "https://api.gemini.com/v1/prediction-markets/events/NFL-2611200115-IND-HOU-M");
});

test("the keeper does not prove in-process unless ZK_IN_KEEPER=1 (proving blocked the event loop and Render restarted it)", async () => {
  const { zkInKeeper } = await import("../src/zkproof.js");
  const saved = { t: process.env.RECLAIM_ORG_TOKEN, k: process.env.ZK_IN_KEEPER };
  process.env.RECLAIM_ORG_TOKEN = "x";
  delete process.env.ZK_IN_KEEPER;
  assert.equal(zkInKeeper(), false);
  process.env.ZK_IN_KEEPER = "1";
  assert.equal(zkInKeeper(), true);
  delete process.env.RECLAIM_ORG_TOKEN;
  assert.equal(zkInKeeper(), false);
  if (saved.t === undefined) delete process.env.RECLAIM_ORG_TOKEN; else process.env.RECLAIM_ORG_TOKEN = saved.t;
  if (saved.k === undefined) delete process.env.ZK_IN_KEEPER; else process.env.ZK_IN_KEEPER = saved.k;
});
