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
