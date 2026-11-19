import { useEffect, useMemo, useState } from "react";
import PromiseDoc from "../components/PromiseDoc.jsx";
import { loadEvents, requestQuote, indicativePremium, pricerConfigured } from "../lib/pricer.js";
import { buyCover } from "../lib/wallet.js";
import { txUrl } from "../lib/config.js";
import { usd, pct, cents, when, sportOf, isChampionship, isSecondHalf, phase } from "../lib/format.js";

const PRESETS = [500, 2000, 5000];

export function verifyLink(policyId, { ticker, label, merchant }) {
  const q = new URLSearchParams();
  if (ticker) q.set("t", ticker);
  if (label) q.set("l", label);
  if (merchant) q.set("m", merchant);
  return `${location.origin}${location.pathname}#/p/${policyId}?${q}`;
}

export default function PromisePage({ account, onConnect }) {
  const [data, setData] = useState(null);
  const [filter, setFilter] = useState("All");
  const [eventTicker, setEventTicker] = useState(null);
  const [symbol, setSymbol] = useState(null);
  const [payout, setPayout] = useState(5000);
  const [merchant, setMerchant] = useState("");
  const [quote, setQuote] = useState(null);
  const [busy, setBusy] = useState(null);
  const [err, setErr] = useState(null);
  const [done, setDone] = useState(null);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    loadEvents().then((d) => {
      setData(d);
      const first = d.events.find((e) => e.ticker.startsWith("NFL-2611221800-ARI-KC-M")) ?? d.events[0];
      if (first) setEventTicker(first.ticker);
    });
  }, []);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const events = data?.events ?? [];
  const byTicker = useMemo(() => Object.fromEntries(events.map((e) => [e.ticker, e])), [events]);
  const sports = useMemo(() => ["All", ...new Set(events.filter((e) => !e.parentTicker).map((e) => (isChampionship(e) ? "Championships" : sportOf(e))))], [events]);
  const list = events.filter((e) => !e.parentTicker && (filter === "All" || (isChampionship(e) ? "Championships" : sportOf(e)) === filter));

  const event = byTicker[eventTicker];
  const parent = event?.parentTicker ? byTicker[event.parentTicker] : event;
  const half = parent ? events.find((e) => e.parentTicker === parent.ticker && isSecondHalf(e)) : null;
  const contract = event?.contracts.find((c) => c.instrumentSymbol === symbol);
  const ask = Number(contract?.prices?.bestAsk);
  const ph = event ? phase(event, now) : "pre";

  // default team: the underdog (cheapest ask), which is the promo that makes sense
  useEffect(() => {
    if (!event) return;
    const open = event.contracts.filter((c) => c.marketState === "open" && Number(c.prices?.bestAsk) > 0);
    const dog = open.filter((c) => !/-D$/.test(c.instrumentSymbol)).sort((a, b) => Number(a.prices.bestAsk) - Number(b.prices.bestAsk))[0];
    setSymbol(dog?.instrumentSymbol ?? null);
    setQuote(null);
    setDone(null);
  }, [eventTicker]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => setQuote(null), [symbol, payout]);

  const indicative = contract && ask > 0 ? indicativePremium({ payout, ask }) : null;
  const tooLikely = ask > 0.5;
  const secsLeft = quote ? Math.max(0, Number(quote.quote.expiry) - Math.floor(now / 1000)) : 0;

  async function getQuote() {
    setErr(null);
    if (!account) return onConnect();
    setBusy("Pricing from Gemini…");
    try {
      setQuote(await requestQuote({ eventTicker: event.ticker, instrumentSymbol: symbol, payoutUsdc: payout, buyer: account }));
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(null);
    }
  }

  async function seal() {
    setErr(null);
    try {
      const r = await buyCover(account, quote, (s) => setBusy(`${s}… confirm in your wallet`));
      setDone({ ...r, label: contract.label, ticker: event.ticker });
      setQuote(null);
    } catch (e) {
      setErr(e.shortMessage ?? e.message);
    } finally {
      setBusy(null);
    }
  }

  const b = quote?.breakdown;
  const lines = done
    ? [["Payout locked", usd(payout)], ["Premium paid", usd(b?.premium ?? indicative?.premium)], ["Settles from", "Gemini result, 2-of-3 quorum"]]
    : b
      ? [
          ["Hedge on Gemini", `${usd(b.hedgeCost)} @ ${cents(b.pExec)}`],
          ["Buffer + capacity", usd((b.buffer ?? 0) + (b.utilizationSurcharge ?? 0))],
          ["Capital charge", usd(b.capitalCharge)],
          ["Premium", usd(b.premium), "total"],
        ]
      : indicative
        ? [
            ["Hedge on Gemini", `${usd(indicative.hedge)} @ ${cents(indicative.p)}`],
            ["Buffer + capacity", usd(indicative.buffer + indicative.surcharge)],
            ["Capital charge", usd(indicative.capital)],
            ["Premium (indicative)", usd(indicative.premium), "total"],
          ]
        : [];

  const multiple = (b?.premium ?? indicative?.premium) ? payout / (b?.premium ?? indicative.premium) : null;

  return (
    <div className="grid-2">
      <section>
        <h1 className="display">
          Make the promise.
          <br />
          <em>Keep it, provably.</em>
        </h1>
        <p className="lede">
          "If our team wins, it's on us." Arra prices the upset from Gemini's order book, locks the payout in USDC on Arc, and
          pays you the moment the result settles. Your customers scan to check it's real.
        </p>

        <div className="panel">
          <div className="row" style={{ marginBottom: 12 }}>
            <h3>1 · Pick the game</h3>
            <span className="chip">
              <span className={`dot ${data?.live ? "live" : "warn"}`} />
              {data ? (data.live ? "Live Gemini markets" : `Gemini snapshot · ${when(data.capturedAt)}`) : "Loading markets"}
            </span>
          </div>
          <div className="tabs" role="group" aria-label="Sport">
            {sports.map((s) => (
              <button key={s} className="tab" aria-pressed={filter === s} onClick={() => setFilter(s)}>
                {s}
              </button>
            ))}
          </div>
          <div className="games">
            {!data && [0, 1, 2].map((i) => <div key={i} className="skeleton" style={{ height: 56 }} />)}
            {list.map((e) => {
              const p = phase(e, now);
              return (
                <button key={e.ticker} className="game" aria-pressed={parent?.ticker === e.ticker} onClick={() => setEventTicker(e.ticker)}>
                  <span className="t">{e.title}</span>
                  <span className={`badge ${p === "live" ? "live" : ""}`}>{p === "live" ? "Live" : p === "done" ? "Closed" : isChampionship(e) ? `${e.contracts.length} teams` : sportOf(e)}</span>
                  <span className="when">{when(e.startTime)}</span>
                </button>
              );
            })}
          </div>
        </div>

        {parent && (
          <div className="panel">
            <div className="row" style={{ marginBottom: 12 }}>
              <h3>2 · Pick your team</h3>
              {half && (
                <button className={`btn ${event?.ticker === half.ticker ? "primary" : "ghost"}`} onClick={() => setEventTicker(event?.ticker === half.ticker ? parent.ticker : half.ticker)}>
                  {event?.ticker === half.ticker ? "Halftime comeback: on" : "Halftime comeback"}
                </button>
              )}
            </div>
            {event?.ticker === half?.ticker && (
              <p className="sub">Cover just the 2nd half, priced live off Gemini's 2nd-half winner market. In-game quotes live 20 seconds.</p>
            )}
            <div className="teams">
              {event.contracts.map((c) => {
                const a = Number(c.prices?.bestAsk);
                const disabled = c.marketState !== "open" || !(a > 0) || a > 0.5 || /-D$/.test(c.instrumentSymbol);
                return (
                  <button key={c.instrumentSymbol} className="team" aria-pressed={symbol === c.instrumentSymbol} disabled={disabled} onClick={() => setSymbol(c.instrumentSymbol)} title={a > 0.5 ? "Favorites can't be covered: cover would cost about as much as the promo" : ""}>
                    <span>{c.label}</span>
                    <span className="p">{a > 0 ? cents(a) : "—"}</span>
                  </button>
                );
              })}
            </div>
            {tooLikely && <p className="note" style={{ marginTop: 12 }}>Arra only covers long shots: promising on a favorite costs about as much as the giveaway.</p>}
          </div>
        )}

        <div className="panel">
          <h3>3 · How big is the promise?</h3>
          <p className="sub">Your real cost of honoring it (cost of goods, not menu price).</p>
          <label className="field" htmlFor="payout">Payout if they win (USDC)</label>
          <div className="amount">
            <span className="num muted">$</span>
            <input id="payout" inputMode="decimal" value={payout} onChange={(e) => setPayout(Math.max(0, Number(e.target.value.replace(/[^0-9.]/g, "")) || 0))} />
          </div>
          <div className="presets">
            {PRESETS.map((p) => (
              <button key={p} className="tab" aria-pressed={payout === p} onClick={() => setPayout(p)}>
                {usd(p, 0)}
              </button>
            ))}
            <button className="tab" aria-pressed={payout === 5} onClick={() => setPayout(5)} title="Testnet-sized: fits the demo vault">
              $5 testnet
            </button>
          </div>
          <label className="field" htmlFor="merchant" style={{ marginTop: 14 }}>Business name (shown on the promise)</label>
          <div className="amount">
            <input id="merchant" style={{ fontFamily: "var(--sans)", fontSize: 16 }} placeholder="e.g. Lone Star Taproom" value={merchant} onChange={(e) => setMerchant(e.target.value.slice(0, 40))} />
          </div>
        </div>
      </section>

      <aside style={{ position: "sticky", top: 24 }}>
        <PromiseDoc
          merchant={merchant}
          team={contract?.label}
          eventTitle={event?.title}
          payout={payout}
          lines={lines}
          status={done ? "locked" : quote ? "quoted" : "draft"}
          policyId={done?.policyId}
          verifyUrl={done ? verifyLink(done.policyId, { ticker: done.ticker, label: done.label, merchant }) : null}
        />

        <div className="panel" style={{ marginTop: 16 }}>
          {done ? (
            <div className="stack">
              <h3>Sealed. The payout is locked on Arc.</h3>
              <p className="sub">Print the QR on table tents. Anyone who scans it sees the locked USDC, the Gemini hedge and the settlement status.</p>
              <div className="row">
                <a className="btn" href={txUrl(done.hash)} target="_blank" rel="noreferrer">View transaction</a>
                <a className="btn primary" href={`#/p/${done.policyId}?${new URLSearchParams({ t: done.ticker, l: done.label, ...(merchant ? { m: merchant } : {}) })}`}>Open proof page</a>
              </div>
            </div>
          ) : (
            <div className="stack">
              <div className="row">
                <span className="muted">Marketing multiple</span>
                <span className="num">{multiple ? `${multiple.toFixed(1)}×` : "—"}</span>
              </div>
              <div className="row">
                <span className="muted">Premium as % of payout</span>
                <span className="num">{(b?.premium ?? indicative?.premium) ? pct((b?.premium ?? indicative.premium) / payout) : "—"}</span>
              </div>
              {b && (
                <div className="row">
                  <span className="muted">Price source</span>
                  <span className="num">{b.bookSource === "ws-depth" ? "Gemini depth (live)" : "Gemini top of book"}</span>
                </div>
              )}
              {quote ? (
                <>
                  <button className="btn primary big" onClick={seal} disabled={!!busy || secsLeft === 0}>
                    {busy ?? (secsLeft === 0 ? "Quote expired" : "Seal the promise")}
                  </button>
                  <div className="row">
                    <span className="countdown">Signed quote · {secsLeft}s</span>
                    <button className="btn ghost" onClick={getQuote} disabled={!!busy}>Re-quote</button>
                  </div>
                </>
              ) : (
                <button className="btn primary big" onClick={getQuote} disabled={!!busy || !contract || tooLikely || !(payout > 0) || ph === "done" || !pricerConfigured()}>
                  {busy ?? (!account ? "Connect wallet to quote" : ph === "live" ? "Get live in-game quote" : "Get signed quote")}
                </button>
              )}
              {!pricerConfigured() && <p className="note">Live pricer not connected in this build: premiums shown are indicative, from the same formula and Gemini prices.</p>}
              {err && <p className="err" role="alert">{err}</p>}
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}
