// Keeper: the pricer API plus the settler (and, with Gemini keys, the hedger) in one process, so
// promises bought on the site get settled from Gemini's result without anyone at a terminal.
//   node src/keeper.js
//
// One process also means one registry: the outcome order pinned at an event's first sale is seen
// by the pricer, the settler and the hedger alike. The registry and the evidence bytes settlers
// attest are synced to a durable store (store.js) because the host's disk is wiped on restart; on
// startup the registry is restored from the store and any event still missing is recovered from
// onchain CoverPurchased logs + live Gemini tickers.
//
// Public routes added to the pricer: GET /keeper (loop health, no secrets) and
// GET /evidence/:ticker/:file (attested bytes, served only if they hash to the requested name).
import fs from "node:fs";
import path from "node:path";
import { keccak256, toBytes } from "viem";
import { config } from "./config.js";
import { app } from "./pricer.js";
import { createStore } from "./store.js";
import { readRegistry, remember, REGISTRY_FILE } from "./registry.js";
import { DEFAULT_EVIDENCE_DIR } from "./verify.js";

const TICKER = /^[A-Z0-9][A-Z0-9-]{0,99}$/;
const FILE = /^(0x[0-9a-f]{64}|outcomes)\.json$/;

/** Map onchain event ids (keccak256 of the ticker) back to Gemini events we can see. */
export function resolveTickers(eventIds, events) {
  const want = new Set(eventIds.map((x) => x.toLowerCase()));
  const out = {};
  for (const e of events) {
    const id = keccak256(toBytes(e.ticker));
    if (want.has(id)) out[id] = { eventTicker: e.ticker, title: e.title, event: e };
  }
  return out;
}

/** Add the public keeper routes to an express app. */
export function keeperRoutes(a, { evidenceDir, store, status }) {
  a.get("/keeper", (_req, res) => res.json(status()));
  a.get("/evidence/:ticker/:file", async (req, res) => {
    const { ticker, file } = req.params;
    if (!TICKER.test(ticker) || !FILE.test(file)) return res.status(400).json({ error: "bad ticker or file" });
    let bytes = null;
    const local = path.join(evidenceDir, ticker, file);
    if (fs.existsSync(local)) bytes = new Uint8Array(fs.readFileSync(local));
    else bytes = await store.get(`offchain/evidence/${ticker}/${file}`).catch(() => null);
    // Integrity: an evidence file must hash to its own name (outcomes.json is a plain list).
    if (!bytes || (file !== "outcomes.json" && keccak256(bytes) !== file.replace(".json", ""))) return res.status(404).json({ error: "not found" });
    res.type("application/json").send(Buffer.from(bytes));
  });
  return a;
}

// ---------------------------------------------------------------------------- runtime

async function main() {
  const { publicClient, vaultAbi } = await import("./chain.js");
  const { settleOnce } = await import("./settler.js");
  const { hedgeIfNeeded } = await import("./hedger.js");
  const { listActiveEvents } = await import("./gemini.js");

  const evidenceDir = process.env.EVIDENCE_DIR ?? DEFAULT_EVIDENCE_DIR;
  const store = createStore({ token: process.env.GITHUB_EVIDENCE_TOKEN, repo: process.env.KEEPER_REPO ?? "Qiao527/arra-protocol", branch: process.env.KEEPER_BRANCH ?? "keeper-data" });
  const settleEvery = Number(process.env.SETTLE_INTERVAL_SEC ?? 60) * 1000;
  const hedgerOn = Boolean(config.geminiKey && config.geminiSecret);
  const state = {
    startedAt: new Date().toISOString(),
    vault: config.vault,
    settler: { enabled: config.settlerPks.length > 0, settlers: config.settlerPks.length, lastRunAt: null, lastError: null, eventsTracked: 0, actions: [] },
    hedger: { enabled: hedgerOn, thresholdUsdc: config.hedgeThresholdUsdc, lastRunAt: null, lastError: null },
    store: { enabled: store.enabled, branch: process.env.KEEPER_BRANCH ?? "keeper-data", lastSyncAt: null, lastError: null, evidenceFiles: 0 },
  };
  const note = (k, msg) => {
    state.settler.actions = [{ at: new Date().toISOString(), k, msg }, ...state.settler.actions].slice(0, 20);
    console.log(`keeper ${k}: ${msg}`);
  };

  // 1. Restore the registry from the store, then recover anything still missing from chain logs.
  try {
    const saved = await store.get("offchain/registry/arc-testnet.json");
    if (saved) {
      const merged = { ...JSON.parse(new TextDecoder().decode(saved)), ...readRegistry() };
      fs.mkdirSync(path.dirname(REGISTRY_FILE), { recursive: true });
      fs.writeFileSync(REGISTRY_FILE, JSON.stringify(merged, null, 2));
      note("registry", `restored ${Object.keys(merged).length} events from the store`);
    }
  } catch (e) {
    state.store.lastError = e.message;
  }
  try {
    const logs = await publicClient.getContractEvents({ address: config.vault, abi: vaultAbi, eventName: "CoverPurchased", fromBlock: BigInt(process.env.FROM_BLOCK ?? 0) });
    const missing = [...new Set(logs.map((l) => l.args.eventId))].filter((id) => !readRegistry()[id]);
    if (missing.length) {
      const found = resolveTickers(missing, await listActiveEvents({ maxPages: 20 }));
      for (const [id, { eventTicker, title, event }] of Object.entries(found)) remember(id, { eventTicker, title }, event);
      note("registry", `recovered ${Object.keys(found).length}/${missing.length} events from chain logs`);
    }
  } catch (e) {
    note("error", `registry recovery: ${e.message}`);
  }

  // 2. Sync registry + evidence to the store when they change.
  let lastRegistry = "";
  const pushed = new Set();
  // Single flight: the settler loop and startup both sync; a second caller joins the running one.
  let syncing = null;
  const sync = () => (syncing ??= syncNow().finally(() => (syncing = null)));
  async function syncNow() {
    if (!store.enabled) return;
    try {
      const reg = JSON.stringify(readRegistry(), null, 2);
      if (reg !== lastRegistry) {
        await store.put("offchain/registry/arc-testnet.json", new TextEncoder().encode(reg + "\n"), "keeper: registry");
        lastRegistry = reg;
      }
      if (fs.existsSync(evidenceDir)) {
        for (const t of fs.readdirSync(evidenceDir)) {
          const d = path.join(evidenceDir, t);
          if (!TICKER.test(t) || !fs.statSync(d).isDirectory()) continue;
          for (const f of fs.readdirSync(d).filter((x) => FILE.test(x))) {
            const key = `${t}/${f}`;
            if (pushed.has(key) && f !== "outcomes.json") continue;
            await store.put(`offchain/evidence/${key}`, new Uint8Array(fs.readFileSync(path.join(d, f))), `keeper: evidence ${key}`);
            pushed.add(key);
          }
        }
      }
      state.store.evidenceFiles = pushed.size;
      state.store.lastSyncAt = new Date().toISOString();
      state.store.lastError = null;
    } catch (e) {
      state.store.lastError = e.message;
    }
  }

  // 3. Loops.
  async function settlerLoop() {
    for (;;) {
      try {
        state.settler.eventsTracked = Object.keys(readRegistry()).length;
        const acted = await settleOnce({ onAction: (msg) => note("settle", msg) });
        state.settler.lastRunAt = new Date().toISOString();
        state.settler.lastError = acted.errors.length ? acted.errors.join("; ").slice(0, 500) : null;
      } catch (e) {
        state.settler.lastError = e.message;
      }
      await sync();
      await new Promise((r) => setTimeout(r, settleEvery));
    }
  }
  async function hedgerLoop() {
    for (;;) {
      try {
        for (const id of Object.keys(readRegistry())) {
          const done = await hedgeIfNeeded(id);
          for (const h of done) note("hedge", `${h.instrumentSymbol} -> ${h.venue}: ${h.qty} filled, order ${h.orderId}`);
        }
        state.hedger.lastRunAt = new Date().toISOString();
        state.hedger.lastError = null;
      } catch (e) {
        state.hedger.lastError = e.message;
      }
      await new Promise((r) => setTimeout(r, settleEvery));
    }
  }

  const a = app();
  keeperRoutes(a, { evidenceDir, store, status: () => state });
  a.listen(config.port, () => console.log(`Keeper on :${config.port} (settler: ${state.settler.enabled}, hedger: ${hedgerOn}, store: ${store.enabled})`));
  if (state.settler.enabled) settlerLoop();
  if (hedgerOn) hedgerLoop();
  await sync();
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
