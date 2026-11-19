// Maps onchain eventId (bytes32) -> Gemini market, so bots can go from a log back to Gemini.
import fs from "node:fs";

const FILE = process.env.REGISTRY_PATH ? new URL(`file://${process.env.REGISTRY_PATH}`) : new URL("../data/registry.json", import.meta.url);

export function readRegistry() {
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch {
    return {};
  }
}

export function remember(eventId, info) {
  const r = readRegistry();
  if (r[eventId]) return;
  r[eventId] = info;
  fs.mkdirSync(new URL("../data/", import.meta.url), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(r, null, 2));
}
