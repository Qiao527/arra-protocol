// Gemini WebSocket depth: parser + book maintenance, driven by a LIVE capture
// (fixtures/gemini-ws-depth.json, wss://ws.gemini.com?snapshot=-1, see capturedAt).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

process.env.MOCK_GEMINI = "false";
const { createDepthStore, createDepthStream } = await import("../src/depth.js");
const { getBook, executablePrice } = await import("../src/gemini.js");

const cap = JSON.parse(fs.readFileSync(new URL("./fixtures/gemini-ws-depth.json", import.meta.url), "utf8"));
const frames = cap.frames.map((f) => f.raw);
const parsed = frames.map((r) => JSON.parse(r));
const PHI = "GEMI-NHL-2611200000-PHI-OTT-M-PHI";

test("live capture: first depthUpdate per symbol is the snapshot; symbols come back lowercased", () => {
  const first = parsed.find((m) => m.e === "depthUpdate");
  assert.equal(first.s, first.s.toLowerCase());
  assert.ok(Array.isArray(first.b) && Array.isArray(first.a));
  assert.equal(typeof first.U, "number");
  assert.ok(parsed.some((m) => m.status === 200), "subscribe ack");
});

test("snapshot builds a YES-space book keyed case-insensitively, sorted for a book walk", () => {
  const store = createDepthStore();
  for (const r of frames) store.onFrame(r);
  const book = store.getDepthBook(PHI); // uppercase instrumentSymbol, as Gemini's REST API returns it
  assert.ok(book, "book present");
  assert.equal(book.source, "ws-depth");
  const snap = parsed.find((m) => m.s === PHI.toLowerCase());
  assert.equal(book.asks[0].price, Math.min(...snap.a.map(([p]) => Number(p))));
  assert.equal(book.bids[0].price, Math.max(...snap.b.map(([p]) => Number(p))));
  for (let i = 1; i < book.asks.length; i++) assert.ok(book.asks[i].price > book.asks[i - 1].price);
});

test("deltas: quantity 0 removes a level, non-zero replaces it", () => {
  const store = createDepthStore();
  store.onFrame({ e: "depthUpdate", s: "gemi-x", U: 10, u: 10, b: [["0.40", "100"]], a: [["0.45", "50"], ["0.46", "70"]] });
  assert.equal(store.onFrame({ e: "depthUpdate", s: "gemi-x", U: 10, u: 12, b: [], a: [["0.45", "0.00"], ["0.46", "20"]] }), "delta");
  const b = store.getDepthBook("GEMI-X");
  assert.deepEqual(b.asks, [{ price: 0.46, qty: 20 }]);
  assert.deepEqual(b.bids, [{ price: 0.4, qty: 100 }]);
});

test("a sequence gap drops the book (never price off a book with lost updates)", () => {
  const store = createDepthStore();
  store.onFrame({ e: "depthUpdate", s: "gemi-x", U: 10, u: 10, b: [], a: [["0.45", "50"]] });
  assert.equal(store.onFrame({ e: "depthUpdate", s: "gemi-x", U: 15, u: 16, b: [], a: [] }), "gap");
  assert.equal(store.getDepthBook("gemi-x"), null);
  assert.deepEqual(store.takeGaps(), ["gemi-x"]);
  assert.equal(store.onFrame({ e: "depthUpdate", s: "gemi-x", U: 20, u: 20, b: [], a: [["0.5", "1"]] }), "snapshot");
});

test("already-applied frames are ignored", () => {
  const store = createDepthStore();
  store.onFrame({ e: "depthUpdate", s: "gemi-x", U: 12, u: 12, b: [], a: [["0.45", "50"]] });
  assert.equal(store.onFrame({ e: "depthUpdate", s: "gemi-x", U: 11, u: 12, b: [], a: [["0.45", "0"]] }), "stale-frame");
  assert.equal(store.getDepthBook("gemi-x").asks[0].qty, 50);
});

test("every live delta in the capture applies in sequence (no false gaps)", () => {
  const store = createDepthStore();
  const results = frames.map((r) => store.onFrame(r)).filter(Boolean);
  assert.ok(!results.includes("gap"), `unexpected gap in live capture: ${results.join(",")}`);
  assert.ok(results.includes("snapshot"));
});

test("freshness: a book is served only while the stream is alive (< 5 s since the last frame)", () => {
  let t = 1_000_000;
  const store = createDepthStore({ now: () => t });
  store.onFrame({ e: "depthUpdate", s: "gemi-x", U: 1, u: 1, b: [], a: [["0.2", "10"]] });
  t += 4_999;
  assert.ok(store.getDepthBook("gemi-x"));
  t += 1;
  assert.equal(store.getDepthBook("gemi-x"), null);
  store.onFrame(JSON.stringify({ id: "9", status: 200 })); // any frame (pong, ack) proves liveness
  assert.ok(store.getDepthBook("gemi-x"));
});

test("getBook prefers fresh ws-depth and reports bookSource; falls back to the modeled ladder", () => {
  const store = createDepthStore();
  for (const r of frames) store.onFrame(r);
  const contract = { instrumentSymbol: PHI, prices: { bestAsk: "0.38", bestBid: "0.37" } };
  const live = getBook({ contracts: [contract] }, contract, store.getDepthBook);
  assert.equal(live.source, "ws-depth");
  const modeled = getBook({ contracts: [contract] }, contract, () => null);
  assert.equal(modeled.source, "top-of-book+slippage");
  assert.equal(getBook({ contracts: [contract] }, contract).source, "top-of-book+slippage");
});

test("real depth is far thinner than the modeled ladder: a large cover is refused, not underpriced", () => {
  const store = createDepthStore();
  for (const r of frames) store.onFrame(r);
  const sym = "GEMI-NBAF-2627CHAMP-BOS";
  const contract = { instrumentSymbol: sym, prices: { bestAsk: "0.13", bestBid: "0.07" } };
  const real = executablePrice(getBook({ contracts: [contract] }, contract, store.getDepthBook), "YES", 5000);
  const modeled = executablePrice(getBook({ contracts: [contract] }, contract, () => null), "YES", 5000);
  assert.ok(real.filled < 1000, `real asks hold ${real.filled} contracts`);
  assert.ok(real.filled < 5000 && modeled.filled < 5000, "neither book can fill a $5k cover, so it is refused");
});

test("stream: subscribes on watch, resolves on snapshot, resubscribes after a gap", async () => {
  const sent = [];
  class FakeWS {
    constructor(url) {
      this.url = url;
      this.readyState = 1;
      FakeWS.last = this;
      queueMicrotask(() => this.onopen?.());
    }
    send(x) {
      sent.push(JSON.parse(x));
    }
    close() {}
  }
  const stream = createDepthStream({ WebSocketImpl: FakeWS, pingMs: 60_000 });
  const ready = stream.watch(PHI, 500);
  await new Promise((r) => setTimeout(r, 0));
  assert.match(FakeWS.last.url, /snapshot=-1/);
  assert.deepEqual(sent[0].params, [`${PHI}@depth`]);
  assert.equal(sent[0].method, "SUBSCRIBE");
  FakeWS.last.onmessage({ data: JSON.stringify({ e: "depthUpdate", s: PHI.toLowerCase(), U: 1, u: 1, b: [], a: [["0.38", "50"]] }) });
  assert.equal(await ready, true);
  FakeWS.last.onmessage({ data: JSON.stringify({ e: "depthUpdate", s: PHI.toLowerCase(), U: 9, u: 9, b: [], a: [] }) });
  assert.deepEqual(sent.slice(-2).map((m) => m.method), ["UNSUBSCRIBE", "SUBSCRIBE"]);
  stream.close();
});

test("live: the first delta after a snapshot may straddle it (U < snapshot u < its u) and applies", () => {
  const nyi = parsed.filter((m) => m.s === "gemi-nhl-2611200000-nyi-wpg-m-nyi");
  assert.ok(nyi[1].U < nyi[0].u && nyi[1].u > nyi[0].u, "fixture holds the straddling frame");
  const store = createDepthStore();
  assert.equal(store.onFrame(nyi[0]), "snapshot");
  assert.equal(store.onFrame(nyi[1]), "delta");
});

test("live: update IDs chain (U == previous u); a frame with U past the last u is a gap", () => {
  const store = createDepthStore();
  store.onFrame({ e: "depthUpdate", s: "gemi-x", U: 100, u: 100, b: [], a: [["0.45", "50"]] });
  assert.equal(store.onFrame({ e: "depthUpdate", s: "gemi-x", U: 100, u: 140, b: [], a: [] }), "delta");
  assert.equal(store.onFrame({ e: "depthUpdate", s: "gemi-x", U: 141, u: 150, b: [], a: [] }), "gap"); // 140 -> 141 skipped frames
});

test("live: after every captured delta, no book is crossed (best bid < best ask)", () => {
  const store = createDepthStore();
  for (const r of frames) store.onFrame(r);
  for (const s of cap.subscribed) {
    const b = store.getDepthBook(s);
    assert.ok(b, s);
    if (b.bids.length && b.asks.length) assert.ok(b.bids[0].price < b.asks[0].price, `${s} crossed: ${b.bids[0].price} >= ${b.asks[0].price}`);
  }
});

test("stream: subscribes in batches (a 150-stream SUBSCRIBE got no reply at all from the live server)", async () => {
  const sent = [];
  class FakeWS {
    constructor() {
      this.readyState = 0; // CONNECTING, like a real socket
      FakeWS.last = this;
    }
    send(x) {
      sent.push(JSON.parse(x));
    }
    close() {}
  }
  const stream = createDepthStream({ WebSocketImpl: FakeWS, pingMs: 60_000 });
  for (let i = 0; i < 45; i++) stream.watch(`GEMI-T-${i}`, 1);
  FakeWS.last.readyState = 1;
  FakeWS.last.onopen(); // connects once, then subscribes everything wanted so far
  const subs = sent.filter((m) => m.method === "SUBSCRIBE");
  assert.ok(subs.every((m) => m.params.length <= 20), subs.map((m) => m.params.length).join(","));
  assert.equal(subs.reduce((n, m) => n + m.params.length, 0), 45);
  stream.close();
});
