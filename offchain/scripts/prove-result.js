// zkTLS proof of a Gemini result (Reclaim zkFetch).
//
//   node scripts/prove-result.js <EVENT-TICKER> [--symbol GEMI-...] [--out file]
//
// Fetches https://api.gemini.com/v1/prediction-markets/events/<ticker> through a Reclaim
// attestor and proves the response contains the winning contract with "resolutionSide":"yes".
// The proof (claim + attestor signature) is written to offchain/evidence/zk/<ticker>.json;
// scripts/record-proof.js puts it onchain in ArraResultProofs.
import "dotenv/config";
import path from "node:path";
import { proveResult, eventUrl } from "../src/zkproof.js";

const args = process.argv.slice(2);
const ticker = args.find((a) => !a.startsWith("--"));
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
if (!ticker) { console.error("usage: prove-result.js <EVENT-TICKER> [--symbol SYM]"); process.exit(1); }
if (!process.env.RECLAIM_ORG_TOKEN) { console.error("RECLAIM_ORG_TOKEN missing in offchain/.env"); process.exit(1); }


const url = eventUrl(ticker);
let symbol = opt("--symbol");
if (!symbol) {
  const ev = await (await fetch(url, { headers: { accept: "application/json" } })).json();
  const e = ev.data && !Array.isArray(ev.data) ? ev.data : ev;
  const yes = (e.contracts ?? []).filter((c) => c.resolutionSide === "yes");
  if (yes.length !== 1) { console.error(`${ticker}: expected exactly one YES contract, found ${yes.length} (status ${e.status})`); process.exit(2); }
  symbol = yes[0].instrumentSymbol;
}
console.log(`proving ${symbol} resolved YES in ${ticker}`);

const t0 = Date.now();
const { file, doc } = await proveResult(ticker, symbol, opt("--out") ? { dir: path.dirname(opt("--out")) } : {});
const proof = doc.proof;
const out = file;
console.log(`proof in ${((Date.now() - t0) / 1000).toFixed(1)} s, identifier ${proof.identifier}`);
console.log(`saved ${path.relative(process.cwd(), out)}`);
