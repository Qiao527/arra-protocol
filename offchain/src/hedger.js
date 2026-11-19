// Hedger: when unhedged payout on an outcome crosses HEDGE_THRESHOLD_USDC, buy the same
// outcome on the Gemini SANDBOX and record the hedge onchain (frees cap room).
//
//   node src/hedger.js                 webhook mode: QuickNode Stream POSTs CoverPurchased logs to /quicknode
//   node src/hedger.js --poll          fallback: poll the RPC for CoverPurchased logs
//   DRY_RUN=true node src/hedger.js    log what it would do, no Gemini orders
import express from "express";
import { decodeEventLog } from "viem";
import { config } from "./config.js";
import { getEvent, findContract, getBook, executablePrice, placeSandboxOrder, hedgeTarget } from "./gemini.js";
import { publicClient, operatorWallet, vaultAbi, readEventBooks } from "./chain.js";
import { readRegistry } from "./registry.js";

const vault = { address: config.vault, abi: vaultAbi };
const dryRun = process.env.DRY_RUN === "true";

/**
 * Hedge the vault's worst case. Outcomes are mutually exclusive, so the vault can only ever
 * pay ONE outcome: it hedges each outcome whose unhedged payout (L_i - H_i) exceeds the
 * retention threshold, down to the threshold. Eight cities each insuring their own team at
 * $5k is $40k of promises but at most $5k of payout, so it hedges far less than 1:1 would.
 */
export async function hedgeIfNeeded(eventId) {
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

    const { instrumentSymbol, side } = hedgeTarget(ev, i);
    const fill = executablePrice(getBook(ev, findContract(ev, instrumentSymbol)), side, excess);
    const limit = Math.min(0.99, Number(fill.worstPrice.toFixed(2)));
    console.log(`hedge ${instrumentSymbol} ${side}: ${excess} contracts @ <= ${limit} (outcome ${i}, unhedged ${unhedged})`);

    let orderId = "dry-run";
    if (!dryRun) {
      const order = await placeSandboxOrder({ symbol: instrumentSymbol, outcome: side.toLowerCase(), quantity: excess, price: limit });
      orderId = String(order.orderId ?? order.order_id ?? order.id ?? "unknown");
      console.log(`  Gemini sandbox order ${orderId}`, order.status ?? "");
    }
    const hash = await operatorWallet().writeContract({
      ...vault,
      functionName: "recordHedge",
      args: [eventId, i, BigInt(excess) * 1_000_000n, orderId],
    });
    await publicClient.waitForTransactionReceipt({ hash });
    console.log(`  recordHedge tx ${hash}`);
    done.push({ outcome: i, instrumentSymbol, side, qty: excess, limit, orderId, hash });
  }
  return done;
}

/** QuickNode Streams destination. Body = filter output: { logs: [...] } (raw EVM logs). */
function webhookServer() {
  const a = express();
  a.use(express.json({ limit: "5mb" }));
  a.post("/quicknode", async (req, res) => {
    if (config.quicknodeSecret && req.get("x-arra-secret") !== config.quicknodeSecret) return res.sendStatus(401);
    const logs = req.body?.logs ?? (Array.isArray(req.body) ? req.body.flatMap((b) => b?.logs ?? []) : []);
    res.json({ received: logs.length }); // ack fast; QuickNode retries on non-2xx
    for (const raw of logs) {
      try {
        const ev = decodeEventLog({ abi: vaultAbi, data: raw.data, topics: raw.topics });
        if (ev.eventName !== "CoverPurchased") continue;
        console.log(`stream: policy #${ev.args.policyId} on ${ev.args.eventId}`);
        await hedgeIfNeeded(ev.args.eventId);
      } catch (err) {
        console.error(`hedger (stream): ${err.message}`);
      }
    }
  });
  a.listen(config.hedgerPort, () => console.log(`Hedger webhook on :${config.hedgerPort}/quicknode (dry run: ${dryRun})`));
}

async function poll() {
  console.log(`Hedger polling (threshold ${config.hedgeThresholdUsdc} USDC, dry run: ${dryRun})`);
  let fromBlock = BigInt(process.env.FROM_BLOCK ?? (await publicClient.getBlockNumber()));
  for (;;) {
    const toBlock = await publicClient.getBlockNumber();
    if (toBlock >= fromBlock) {
      const logs = await publicClient.getContractEvents({ ...vault, eventName: "CoverPurchased", fromBlock, toBlock });
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
