// Hedger: when unhedged payout on an outcome crosses HEDGE_THRESHOLD_USDC, buy the same
// outcome on the Gemini SANDBOX and record the hedge onchain (frees cap room).
//
//   node src/hedger.js                 webhook mode: QuickNode Stream POSTs CoverPurchased logs to /quicknode
//   node src/hedger.js --poll          fallback: poll the RPC for CoverPurchased logs
//   DRY_RUN=true node src/hedger.js    log what it would do, no Gemini orders
import crypto from "node:crypto";
import express from "express";
import { decodeEventLog } from "viem";
import { config } from "./config.js";
import { getEvent, findContract, getBook, executablePrice, placeSandboxOrder, hedgeTarget, ensureDepth, sandboxSymbolFor, sandboxBestAsk } from "./gemini.js";
import { publicClient, operatorWallet, vaultAbi, readEventBooks, getLogsChunked } from "./chain.js";
import { readRegistry } from "./registry.js";

const vault = { address: config.vault, abi: vaultAbi };
const dryRun = process.env.DRY_RUN === "true";

/**
 * Contracts Gemini actually filled, from an order response. An IOC limit order can fill
 * partially or not at all, so the vault must record the fill, never the request. Unknown
 * response shape -> 0 (record nothing; the hedge is retried on the next cover).
 */
export function filledContracts(order, requested = Infinity) {
  const raw = order?.filledQuantity ?? order?.filled_quantity ?? order?.executedQuantity ?? order?.executed_amount;
  const n = Number(raw);
  if (raw == null || !Number.isFinite(n) || n <= 0) return 0;
  return Math.min(Math.floor(n), requested);
}

/** Run async jobs one at a time per key (one event's hedges never overlap). */
export function serializeByKey() {
  const tails = new Map();
  return (key, fn) => {
    const next = (tails.get(key) ?? Promise.resolve()).then(fn, fn);
    const tail = next.catch(() => {});
    tails.set(key, tail);
    tail.then(() => tails.get(key) === tail && tails.delete(key));
    return next;
  };
}
const hedgeLock = serializeByKey();

/**
 * Hedge the vault's worst case. Outcomes are mutually exclusive, so the vault can only ever
 * pay ONE outcome: it hedges each outcome whose unhedged payout (L_i - H_i) exceeds the
 * retention threshold, down to the threshold. Eight cities each insuring their own team at
 * $5k is $40k of promises but at most $5k of payout, so it hedges far less than 1:1 would.
 */
export function hedgeIfNeeded(eventId) {
  return hedgeLock(eventId, () => hedgeNow(eventId));
}

async function hedgeNow(eventId) {
  const info = readRegistry()[eventId];
  if (!info) throw new Error(`No Gemini market registered for ${eventId}`);
  const books = await readEventBooks(eventId);
  if (books.state !== "Open") return [];
  const ev = await getEvent(info.eventTicker);
  const done = [];

  for (let i = 0; i < books.liab.length; i++) {
    const unhedged = books.liab[i] - books.hedged[i];
    const excess = Math.floor(unhedged - config.hedgeThresholdUsdc);
    if (excess <= 0) continue;

    const { instrumentSymbol, side } = hedgeTarget(ev, i, info.outcomes);
    await ensureDepth(instrumentSymbol);
    const fill = executablePrice(getBook(ev, findContract(ev, instrumentSymbol)), side, excess);
    const limit = Math.min(0.99, Number(fill.worstPrice.toFixed(2)));
    console.log(`hedge ${instrumentSymbol} ${side}: ${excess} contracts @ <= ${limit} (outcome ${i}, unhedged ${unhedged})`);

    let orderId = "dry-run";
    let filled = excess;
    let venue = instrumentSymbol;
    if (!dryRun) {
      // Sandbox markets differ from production: hedge on the mapped stand-in at ITS ask.
      venue = sandboxSymbolFor(instrumentSymbol);
      let price = limit;
      if (venue !== instrumentSymbol) {
        const { ask } = await sandboxBestAsk(venue);
        if (!Number.isFinite(ask)) throw new Error(`sandbox stand-in ${venue} has no ask`);
        price = ask;
        console.log(`  sandbox stand-in for ${instrumentSymbol}: ${venue} @ ${ask}`);
      }
      const order = await placeSandboxOrder({ symbol: venue, outcome: side.toLowerCase(), quantity: excess, price: price.toFixed(2) });
      orderId = String(order.orderId ?? order.order_id ?? order.id ?? "unknown");
      filled = filledContracts(order, excess);
      console.log(`  Gemini sandbox order ${orderId}: ${order.status ?? ""}, filled ${filled}/${excess} @ ${order.avgExecutionPrice ?? "-"}`);
    }
    if (filled <= 0) {
      console.warn(`  nothing filled on ${instrumentSymbol}; no hedge recorded`);
      continue;
    }
    const hash = await operatorWallet().writeContract({
      ...vault,
      functionName: "recordHedge",
      args: [eventId, i, BigInt(filled) * 1_000_000n, orderId],
    });
    await publicClient.waitForTransactionReceipt({ hash });
    console.log(`  recordHedge tx ${hash}`);
    done.push({ outcome: i, instrumentSymbol, venue, side, qty: filled, limit, orderId, hash });
  }
  return done;
}

const digest = (x) => crypto.createHash("sha256").update(String(x)).digest();
const sameSecret = (a, b) => typeof a === "string" && crypto.timingSafeEqual(digest(a), digest(b));

/**
 * QuickNode Streams destination. Body = filter output: { logs: [...] } (raw EVM logs).
 * Fails closed: no QUICKNODE_WEBHOOK_SECRET configured -> 503, wrong x-arra-secret -> 401.
 * QuickNode retries deliveries, so each log (txHash:logIndex) is handed to onLog once.
 */
export function webhookApp({ secret, onLog, maxRemembered = 10_000 }) {
  const seen = new Set();
  const a = express();
  a.use(express.json({ limit: "1mb" }));
  a.post("/quicknode", (req, res) => {
    if (!secret) return res.status(503).json({ error: "QUICKNODE_WEBHOOK_SECRET not set" });
    if (!sameSecret(req.get("x-arra-secret"), secret)) return res.sendStatus(401);
    const logs = req.body?.logs ?? (Array.isArray(req.body) ? req.body.flatMap((b) => b?.logs ?? []) : []);
    const fresh = [];
    for (const raw of logs) {
      const id = `${raw?.transactionHash}:${raw?.logIndex}`;
      if (seen.has(id)) continue;
      seen.add(id);
      if (seen.size > maxRemembered) seen.delete(seen.values().next().value);
      fresh.push(raw);
    }
    res.json({ received: logs.length, new: fresh.length }); // ack fast; QuickNode retries on non-2xx
    (async () => {
      for (const raw of fresh) {
        try {
          await onLog(raw);
        } catch (err) {
          console.error(`hedger (stream): ${err.message}`);
        }
      }
    })();
  });
  return a;
}

/** Decode one raw log and hedge its event (serialized per event by hedgeIfNeeded). */
async function onCoverLog(raw) {
  const ev = decodeEventLog({ abi: vaultAbi, data: raw.data, topics: raw.topics });
  if (ev.eventName !== "CoverPurchased") return;
  console.log(`stream: policy #${ev.args.policyId} on ${ev.args.eventId}`);
  await hedgeIfNeeded(ev.args.eventId);
}

function webhookServer() {
  if (!config.quicknodeSecret) console.warn("QUICKNODE_WEBHOOK_SECRET not set: the webhook will refuse every delivery");
  webhookApp({ secret: config.quicknodeSecret, onLog: onCoverLog }).listen(config.hedgerPort, () =>
    console.log(`Hedger webhook on :${config.hedgerPort}/quicknode (dry run: ${dryRun})`)
  );
}

async function poll() {
  console.log(`Hedger polling (threshold ${config.hedgeThresholdUsdc} USDC, dry run: ${dryRun})`);
  let fromBlock = BigInt(process.env.FROM_BLOCK ?? (await publicClient.getBlockNumber()));
  for (;;) {
    const toBlock = await publicClient.getBlockNumber();
    if (toBlock >= fromBlock) {
      const logs = await getLogsChunked(publicClient, { ...vault, eventName: "CoverPurchased" }, { fromBlock, toBlock });
      for (const log of logs) {
        try {
          await hedgeIfNeeded(log.args.eventId);
        } catch (err) {
          console.error(`hedger: ${err.message}`);
        }
      }
      fromBlock = toBlock + 1n;
    }
    await new Promise((r) => setTimeout(r, 5_000));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.includes("--poll")) await poll();
  else webhookServer();
}
