// Real order-book depth from Gemini's public WebSocket (wss://ws.gemini.com).
//
//   Subscribe:  {"id":"1","method":"SUBSCRIBE","params":["<instrumentSymbol>@depth"]}
//   Frames:     {"e":"depthUpdate","E":<ns>,"s":"<symbol, lowercased>","U":<first id>,"u":<last id>,
//                "b":[["0.3700","54.00"],...],"a":[["0.3800","50.00"],...]}
//
// With ?snapshot=-1 the FIRST depthUpdate per symbol after subscribing is the full book; later
// frames are deltas (quantity 0 removes a level, otherwise the level is replaced). Update IDs
// chain (next U == last u); a frame whose U is past the last applied u means updates were lost:
// the book is dropped and resubscribed.
// Prices are YES-space for every contract (Gemini normalizes NO orders into the YES book).
// Format verified against a live capture: test/fixtures/gemini-ws-depth.json.

export const DEPTH_URL = "wss://ws.gemini.com?snapshot=-1";
export const FRESH_MS = 5_000;
export const SUBSCRIBE_BATCH = 20;

const key = (symbol) => String(symbol).toLowerCase(); // the stream echoes symbols lowercased

function applyLevels(side, levels) {
  for (const [p, q] of levels ?? []) {
    const price = Number(p);
    const qty = Number(q);
    if (!Number.isFinite(price) || !Number.isFinite(qty)) continue;
    if (qty <= 0) side.delete(price);
    else side.set(price, qty);
  }
}

/**
 * Pure book store: feed it raw frames, read YES-space books. No I/O, so it is unit-testable
 * from captured frames. `now` is injectable for freshness tests.
 */
export function createDepthStore({ now = () => Date.now(), freshMs = FRESH_MS } = {}) {
  const books = new Map(); // key(symbol) -> { bids: Map, asks: Map, lastU }
  const waiters = new Map(); // key(symbol) -> [resolve]
  let lastFrameAt = 0; // stream liveness: any frame (data, ack, pong) proves the socket is alive
  const gaps = new Set(); // symbols that need a resubscribe

  function onFrame(raw) {
    lastFrameAt = now();
    let m;
    try {
      m = typeof raw === "string" ? JSON.parse(raw) : raw;
    } catch {
      return null;
    }
    if (m?.e !== "depthUpdate" || !m.s) return null;
    const k = key(m.s);
    const book = books.get(k);
    if (!book) {
      // A snapshot frame has U == u (every one of 23 live snapshots did; none of 1,078 deltas
      // did). Deltas still in flight from before a gap must not become a partial book.
      if (Number(m.U) !== Number(m.u)) return "awaiting-snapshot";
      // changedAt: when a delta last moved this book. A snapshot only says what the book is now,
      // not that anyone is still trading it, so it doesn't count (in-game quotes need movement).
      const fresh = { bids: new Map(), asks: new Map(), lastU: Number(m.u), changedAt: null };
      applyLevels(fresh.bids, m.b);
      applyLevels(fresh.asks, m.a);
      books.set(k, fresh);
      for (const w of waiters.get(k) ?? []) w(true);
      waiters.delete(k);
      return "snapshot";
    }
    if (Number(m.u) <= book.lastU) return "stale-frame"; // already applied
    // IDs are global and chain: each frame's U equals the previous frame's u (verified on the
    // live feed). The first delta after a snapshot may straddle it (U < lastU < u); levels are
    // absolute, so re-applying the overlap is safe. U beyond lastU means frames were lost.
    if (Number(m.U) > book.lastU) {
      books.delete(k); // lost updates: never price off a book we know is wrong
      gaps.add(k);
      return "gap";
    }
    applyLevels(book.bids, m.b);
    applyLevels(book.asks, m.a);
    book.lastU = Number(m.u);
    book.changedAt = now();
    return "delta";
  }

  /** YES-space book {asks ascending, bids descending}, or null if unknown or not fresh. */
  function getDepthBook(symbol) {
    const b = books.get(key(symbol));
    if (!b || now() - lastFrameAt >= freshMs) return null;
    const levels = (side) => [...side].map(([price, qty]) => ({ price, qty }));
    return {
      asks: levels(b.asks).sort((x, y) => x.price - y.price),
      bids: levels(b.bids).sort((x, y) => y.price - x.price),
      source: "ws-depth",
      ageMs: now() - lastFrameAt,
      changedAgeMs: b.changedAt === null ? null : now() - b.changedAt,
    };
  }

  /** Resolve true once a snapshot for `symbol` arrives, false after timeoutMs. */
  function waitFor(symbol, timeoutMs) {
    const k = key(symbol);
    if (books.has(k)) return Promise.resolve(true);
    return new Promise((resolve) => {
      const list = waiters.get(k) ?? [];
      const t = setTimeout(() => resolve(false), timeoutMs);
      list.push((v) => (clearTimeout(t), resolve(v)));
      waiters.set(k, list);
    });
  }

  return {
    onFrame,
    getDepthBook,
    waitFor,
    has: (symbol) => books.has(key(symbol)),
    forget: (symbol) => books.delete(key(symbol)),
    takeGaps: () => {
      const g = [...gaps];
      gaps.clear();
      return g;
    },
    reset: () => books.clear(), // on reconnect every book must be re-snapshotted
  };
}

/**
 * Live stream: one socket, subscribes on demand, pings to prove liveness, resubscribes a
 * symbol after a sequence gap and everything after a reconnect.
 */
export function createDepthStream({ url = DEPTH_URL, WebSocketImpl = globalThis.WebSocket, store = createDepthStore(), pingMs = 2_000 } = {}) {
  const wanted = new Map(); // key -> instrumentSymbol as Gemini returned it
  let ws = null;
  let id = 1;
  let closed = false;
  let pinger = null;

  const send = (method, params) => ws?.readyState === 1 && ws.send(JSON.stringify({ id: String(id++), method, params }));
  // Batches of 20: a single SUBSCRIBE for 150 streams got no reply at all from the live server,
  // while 20 per message worked (2026-11-19 capture).
  const subscribe = (symbols) => {
    for (let i = 0; i < symbols.length; i += SUBSCRIBE_BATCH) send("SUBSCRIBE", symbols.slice(i, i + SUBSCRIBE_BATCH).map((s) => `${s}@depth`));
  };

  function connect() {
    if (closed || !WebSocketImpl) return;
    store.reset();
    ws = new WebSocketImpl(url);
    ws.onopen = () => subscribe([...wanted.values()]);
    ws.onmessage = (m) => {
      store.onFrame(String(m.data));
      const gaps = store.takeGaps().map((k) => wanted.get(k)).filter(Boolean);
      if (gaps.length) {
        send("UNSUBSCRIBE", gaps.map((s) => `${s}@depth`));
        subscribe(gaps); // a fresh subscribe delivers a fresh snapshot
      }
    };
    ws.onclose = () => {
      if (!closed) setTimeout(connect, 1_000);
    };
    ws.onerror = () => {};
    clearInterval(pinger);
    pinger = setInterval(() => send("ping", {}), pingMs);
    pinger.unref?.();
  }

  return {
    store,
    getDepthBook: store.getDepthBook,
    /** Start streaming `symbol` (idempotent). Resolves when its snapshot is in, or after timeoutMs. */
    watch(symbol, timeoutMs = 1_500) {
      const k = key(symbol);
      if (!wanted.has(k)) {
        wanted.set(k, symbol);
        if (!ws) connect();
        else subscribe([symbol]);
      }
      return store.waitFor(symbol, timeoutMs);
    },
    close() {
      closed = true;
      clearInterval(pinger);
      ws?.close();
    },
  };
}
