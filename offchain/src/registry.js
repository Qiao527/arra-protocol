// Maps onchain eventId (bytes32) -> Gemini market, so bots can go from a log back to Gemini.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { outcomeSymbols } from "./gemini.js";

const FILE = process.env.REGISTRY_PATH ? new URL(`file://${process.env.REGISTRY_PATH}`) : new URL("../data/registry.json", import.meta.url);
export const REGISTRY_FILE = fileURLToPath(FILE);

export function readRegistry() {
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch {
    return {};
  }
}

/** Canonical outcome order of an event right now (contracts sorted by instrumentSymbol). */
export const snapshotOutcomes = (event) => outcomeSymbols(event);

/**
 * Record the event and pin its outcome order. The first quote pins the canonical order; later
 * quotes only append contracts Gemini added since, so an index already sold never moves.
 * Returns the pinned order.
 */
export function remember(eventId, info, event) {
  const r = readRegistry();
  const prev = r[eventId];
  const outcomes = event ? outcomeSymbols(event, prev?.outcomes) : prev?.outcomes;
  if (prev && JSON.stringify(prev.outcomes) === JSON.stringify(outcomes)) return outcomes;
  r[eventId] = { ...prev, ...info, ...(outcomes ? { outcomes } : {}) };
  fs.mkdirSync(path.dirname(fileURLToPath(FILE)), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(r, null, 2));
  return outcomes;
}
