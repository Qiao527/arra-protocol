// Keeper: durable store (GitHub contents API), registry recovery, public evidence + status routes.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { keccak256, toBytes } from "viem";
import { generatePrivateKey } from "viem/accounts";

process.env.MOCK_GEMINI = "true";
process.env.OPERATOR_PRIVATE_KEY ??= generatePrivateKey();
const { createStore } = await import("../src/store.js");
const { resolveTickers, keeperRoutes } = await import("../src/keeper.js");
const { app } = await import("../src/pricer.js");

// ---------------------------------------------------------------- GitHub store

function fakeGitHub() {
  const files = new Map(); // path -> { sha, content(base64) }
  const refs = new Map([["heads/main", "a".repeat(40)]]);
  const calls = [];
  const fetch = async (url, opts = {}) => {
    const u = new URL(url);
    const method = opts.method ?? "GET";
    calls.push({ method, path: u.pathname, body: opts.body ? JSON.parse(opts.body) : null, auth: opts.headers?.Authorization });
    const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    let m;
    if ((m = u.pathname.match(/\/git\/ref\/(heads\/.+)$/))) return refs.has(m[1]) ? json(200, { object: { sha: refs.get(m[1]) } }) : json(404, { message: "Not Found" });
    if (u.pathname.endsWith("/git/refs") && method === "POST") {
      const b = JSON.parse(opts.body);
      refs.set(b.ref.replace("refs/", ""), b.sha);
      return json(201, {});
    }
    if ((m = u.pathname.match(/\/contents\/(.+)$/))) {
      const p = decodeURIComponent(m[1]);
      if (method === "GET") return files.has(p) ? json(200, { sha: files.get(p).sha, content: files.get(p).content, encoding: "base64" }) : json(404, { message: "Not Found" });
      const b = JSON.parse(opts.body);
      if (files.has(p) && b.sha !== files.get(p).sha) return json(409, { message: "sha mismatch" });
      const raw = Buffer.from(b.content, "base64");
      const sha = createHash("sha1").update(Buffer.concat([Buffer.from(`blob ${raw.length}\0`), raw])).digest("hex"); // git blob sha, as GitHub
      files.set(p, { sha, content: b.content });
      return json(200, {});
    }
    return json(404, {});
  };
  return { fetch, files, refs, calls };
}

test("store: creates the data branch from main, writes, updates with sha, reads back exact bytes", async () => {
  const gh = fakeGitHub();
  const store = createStore({ token: "t0k", repo: "o/r", branch: "keeper-data", fetchImpl: gh.fetch });
  const bytes = new TextEncoder().encode('{"a":1}');
  await store.put("offchain/evidence/X/0xab.json", bytes, "evidence X");
  assert.ok(gh.refs.has("heads/keeper-data"), "branch created");
  const put = gh.calls.find((c) => c.method === "PUT");
  assert.equal(put.body.branch, "keeper-data");
  assert.equal(put.body.committer.name, "Qiao Long");
  assert.equal(Buffer.from(put.body.content, "base64").toString(), '{"a":1}');
  assert.equal(put.auth, "Bearer t0k");
  await store.put("offchain/evidence/X/0xab.json", new TextEncoder().encode('{"a":2}'), "update");
  assert.deepEqual(new TextDecoder().decode(await store.get("offchain/evidence/X/0xab.json")), '{"a":2}');
  assert.equal(await store.get("missing.json"), null);
});

test("store: disabled without a token (local-only mode), never throws", async () => {
  const store = createStore({ token: undefined, repo: "o/r" });
  assert.equal(store.enabled, false);
  assert.equal(await store.get("x"), null);
  assert.equal(await store.put("x", new Uint8Array([1]), "m"), false);
});

// ---------------------------------------------------------------- registry recovery after a restart

test("resolveTickers maps onchain event ids back to Gemini tickers (incl. period markets)", () => {
  const events = [
    { ticker: "NFL-2611200115-IND-HOU-M", title: "Indianapolis vs Houston", contracts: [] },
    { ticker: "NBAF-2627CHAMP", title: "Pro Basketball Champion", contracts: [] },
  ];
  const ids = [keccak256(toBytes("NBAF-2627CHAMP")), keccak256(toBytes("UNKNOWN-EVENT"))];
  const r = resolveTickers(ids, events);
  assert.deepEqual(Object.keys(r), [ids[0]]);
  assert.equal(r[ids[0]].eventTicker, "NBAF-2627CHAMP");
});

// ---------------------------------------------------------------- public routes

async function withServer(a, fn) {
  const server = a.listen(0);
  await new Promise((r) => server.once("listening", r));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
  }
}

test("GET /evidence serves attested bytes only when they hash to the requested name", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arra-keeper-"));
  const bytes = new TextEncoder().encode('{"data":{"ticker":"NFL-X-M"}}');
  const h = keccak256(bytes);
  fs.mkdirSync(path.join(dir, "NFL-X-M"));
  fs.writeFileSync(path.join(dir, "NFL-X-M", `${h}.json`), bytes);
  fs.writeFileSync(path.join(dir, "NFL-X-M", `0x${"00".repeat(32)}.json`), bytes); // tampered: name != hash
  const a = app({ allowedOrigins: ["https://x.example"] });
  keeperRoutes(a, { evidenceDir: dir, store: createStore({}), status: () => ({}) });
  await withServer(a, async (base) => {
    const ok = await fetch(`${base}/evidence/NFL-X-M/${h}.json`);
    assert.equal(ok.status, 200);
    assert.equal(keccak256(new Uint8Array(await ok.arrayBuffer())), h);
    assert.equal((await fetch(`${base}/evidence/NFL-X-M/0x${"00".repeat(32)}.json`)).status, 404);
    assert.equal((await fetch(`${base}/evidence/..%2F..%2Fetc/${h}.json`)).status, 400);
    assert.equal((await fetch(`${base}/evidence/NFL-X-M/passwd`)).status, 400);
  });
});

test("GET /keeper reports loop health without leaking keys", async () => {
  const a = app({ allowedOrigins: ["https://x.example"] });
  keeperRoutes(a, { evidenceDir: os.tmpdir(), store: createStore({}), status: () => ({ settler: { lastRunAt: "t", eventsTracked: 3 }, store: { enabled: false } }) });
  await withServer(a, async (base) => {
    const r = await fetch(`${base}/keeper`);
    assert.equal(r.status, 200);
    const text = await r.text();
    assert.equal(JSON.parse(text).settler.eventsTracked, 3);
    assert.ok(!/[0-9a-f]{64}/i.test(text), "no 32-byte hex (keys) in status");
  });
});

test("store: identical bytes are not re-committed; concurrent puts are serialized; a 409 race is retried", async () => {
  const gh = fakeGitHub();
  let fail409 = 1;
  const racy = async (url, opts = {}) => {
    if ((opts.method ?? "GET") === "PUT" && fail409-- > 0) return new Response(JSON.stringify({ message: "is at x but expected y" }), { status: 409 });
    return gh.fetch(url, opts);
  };
  const store = createStore({ token: "t", repo: "o/r", fetchImpl: racy, retryDelayMs: 1 });
  const b = new TextEncoder().encode("same");
  assert.equal(await store.put("a.json", b, "m"), true); // first PUT hits a 409, retried
  const puts = () => gh.calls.filter((c) => c.method === "PUT").length;
  const before = puts();
  assert.equal(await store.put("a.json", b, "m"), "unchanged");
  assert.equal(puts(), before, "no commit for identical content");
  await Promise.all([store.put("x.json", new TextEncoder().encode("1"), "m"), store.put("y.json", new TextEncoder().encode("2"), "m")]);
  let inFlight = 0;
  let maxInFlight = 0;
  const slow = async (url, opts = {}) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    try {
      return await gh.fetch(url, opts);
    } finally {
      inFlight--;
    }
  };
  const s2 = createStore({ token: "t", repo: "o/r", fetchImpl: slow });
  await Promise.all([s2.put("p.json", new TextEncoder().encode("p"), "m"), s2.put("q.json", new TextEncoder().encode("q"), "m")]);
  assert.equal(maxInFlight, 1, "one GitHub request at a time");
});

test("GET /registry lists tracked events (tickers + pinned outcome order) and GET /proofs serves the latest run", async () => {
  const gh = fakeGitHub();
  const store = createStore({ token: "t", repo: "o/r", fetchImpl: gh.fetch });
  const proofs = { generatedAt: "2026-11-19T21:00:00Z", events: [{ eventTicker: "NFL-X-M", verdict: "PASS" }] };
  await store.put("offchain/proofs/arc-testnet.json", new TextEncoder().encode(JSON.stringify(proofs)), "proofs");
  const a = app({ allowedOrigins: ["https://x.example"] });
  const registry = { ["0x" + "ab".repeat(32)]: { eventTicker: "NFL-X-M", title: "X vs Y", outcomes: ["GEMI-NFL-X-M-X", "GEMI-NFL-X-M-Y"] } };
  keeperRoutes(a, { evidenceDir: os.tmpdir(), store, status: () => ({}), registry: () => registry });
  await withServer(a, async (base) => {
    const r = await (await fetch(`${base}/registry`)).json();
    assert.equal(r["0x" + "ab".repeat(32)].eventTicker, "NFL-X-M");
    assert.deepEqual(r["0x" + "ab".repeat(32)].outcomes, ["GEMI-NFL-X-M-X", "GEMI-NFL-X-M-Y"]);
    const p = await fetch(`${base}/proofs`);
    assert.equal(p.status, 200);
    assert.equal((await p.json()).events[0].verdict, "PASS");
  });
});

test("self-ping: on Render the keeper hits its own public /health so the free plan never sleeps it", async () => {
  const { startSelfPing } = await import("../src/keeper.js");
  const hits = [];
  let tick;
  const timer = startSelfPing({
    url: "https://arra-pricer.onrender.com/",
    fetchImpl: async (u) => (hits.push(u), { ok: true }),
    setIntervalImpl: (fn, ms) => ((tick = fn), assert.ok(ms < 15 * 60_000, "must beat the 15-minute idle limit"), { unref() {} }),
  });
  assert.ok(timer);
  await tick();
  assert.deepEqual(hits, ["https://arra-pricer.onrender.com/health"]);
  assert.equal(startSelfPing({ url: undefined }), null, "off the platform (no RENDER_EXTERNAL_URL) it does nothing");
  const failing = startSelfPing({ url: "https://x.example", fetchImpl: async () => { throw new Error("down"); }, setIntervalImpl: (fn) => ((tick = fn), {}) });
  await tick(); // a failed ping must not crash the keeper
  assert.ok(failing);
});
