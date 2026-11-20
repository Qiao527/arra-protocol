// Put a zkTLS proof of a Gemini result onchain (ArraResultProofs on Arc).
//   node scripts/record-proof.js evidence/zk/<ticker>.json
// Anyone can call `prove`: the contract checks the URL, the winning-contract match and the
// Reclaim attestor's signature, so the sender's key only pays gas.
import "dotenv/config";
import fs from "node:fs";
import { recordProof } from "../src/zkproof.js";

const file = process.argv[2];
if (!file) { console.error("usage: record-proof.js <proof.json>"); process.exit(1); }
const doc = JSON.parse(fs.readFileSync(file, "utf8"));
const hash = await recordProof(doc);
console.log(`${doc.eventTicker}: ${doc.winningSymbol} proven onchain, tx ${hash}`);
