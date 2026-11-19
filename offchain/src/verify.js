// Proof-of-Promise verifier: anyone can check what the settlers attested.
//   evidenceHash (onchain) == keccak256(raw Gemini response bytes the settlers voted on)
//   winningOutcome (onchain) == the outcome those bytes imply, in the canonical outcome order
// Gemini responses change over time (prices, timestamps, volume), so a re-fetch rarely hashes
// to the attested value. Settlers therefore store the exact bytes at vote time (evidence/).
import fs from "node:fs";
import path from "node:path";
import { keccak256 } from "viem";
import { settledOutcome } from "./settler.js";

export const DEFAULT_EVIDENCE_DIR = new URL("../evidence/", import.meta.url).pathname;

const safe = (ticker) => String(ticker).replace(/[^A-Za-z0-9._-]/g, "_");

/** Parse a Gemini event response (bare event or { data: event }). */
export function parseEvent(bytes) {
  const parsed = JSON.parse(new TextDecoder().decode(bytes).replace(/^﻿/, ""));
  return parsed?.data && !Array.isArray(parsed.data) ? parsed.data : parsed;
}

export function verifyEvidence({ bytes, onchain, eventTicker, outcomes }) {
  const checks = [];
  const hash = keccak256(bytes);
  checks.push({ name: "event settled onchain", ok: onchain.state === "Settled", detail: onchain.state });
  checks.push({ name: "evidence hash", ok: hash === onchain.evidenceHash, detail: `bytes ${hash} vs onchain ${onchain.evidenceHash}` });
  let implied = null;
  try {
    const ev = parseEvent(bytes);
    // Bytes for a different event could imply the same index; the ticker must match too.
    checks.push({ name: "evidence is for this event", ok: !!eventTicker && ev?.ticker === eventTicker, detail: `bytes say ${ev?.ticker}, expected ${eventTicker}` });
    implied = settledOutcome(ev, outcomes);
  } catch (err) {
    checks.push({ name: "evidence parses", ok: false, detail: err.message });
  }
  checks.push({
    name: "winning outcome",
    ok: implied !== null && implied === Number(onchain.winningOutcome),
    detail: `evidence implies ${implied ?? "no result"}, onchain ${onchain.winningOutcome}`,
  });
  return { pass: checks.every((c) => c.ok), checks, impliedOutcome: implied, hash };
}

export function saveEvidence({ dir = DEFAULT_EVIDENCE_DIR, eventTicker, bytes }) {
  const d = path.join(dir, safe(eventTicker));
  fs.mkdirSync(d, { recursive: true });
  const file = path.join(d, `${keccak256(bytes)}.json`);
  fs.writeFileSync(file, bytes);
  return file;
}

/** Outcome order pinned at first sale, stored next to the evidence so anyone can recompute the winner. */
export function saveOutcomes({ dir = DEFAULT_EVIDENCE_DIR, eventTicker, outcomes }) {
  if (!outcomes?.length) return null;
  const d = path.join(dir, safe(eventTicker));
  fs.mkdirSync(d, { recursive: true });
  const file = path.join(d, "outcomes.json");
  fs.writeFileSync(file, JSON.stringify(outcomes, null, 1) + "\n");
  return file;
}

export function loadOutcomes({ dir = DEFAULT_EVIDENCE_DIR, eventTicker }) {
  const file = path.join(dir, safe(eventTicker), "outcomes.json");
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : undefined;
}

/**
 * Fetch attested bytes from a keeper's public /evidence route. Returns them only if they hash to
 * the expected evidenceHash, so the keeper (or anyone in between) cannot substitute other bytes.
 */
export async function fetchEvidence({ base, eventTicker, evidenceHash, fetchImpl = globalThis.fetch }) {
  if (!base) return null;
  try {
    const r = await fetchImpl(`${base.replace(/\/$/, "")}/evidence/${encodeURIComponent(eventTicker)}/${String(evidenceHash).toLowerCase()}.json`);
    if (!r.ok) return null;
    const bytes = new Uint8Array(await r.arrayBuffer());
    return keccak256(bytes) === String(evidenceHash).toLowerCase() ? bytes : null;
  } catch {
    return null;
  }
}

export async function fetchOutcomes({ base, eventTicker, fetchImpl = globalThis.fetch }) {
  if (!base) return undefined;
  try {
    const r = await fetchImpl(`${base.replace(/\/$/, "")}/evidence/${encodeURIComponent(eventTicker)}/outcomes.json`);
    return r.ok ? await r.json() : undefined;
  } catch {
    return undefined;
  }
}

export function loadEvidence({ dir = DEFAULT_EVIDENCE_DIR, eventTicker, evidenceHash }) {
  const file = path.join(dir, safe(eventTicker), `${String(evidenceHash).toLowerCase()}.json`);
  return fs.existsSync(file) ? new Uint8Array(fs.readFileSync(file)) : null;
}
