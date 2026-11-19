import { useEffect, useMemo, useRef, useState } from "react";
import PromiseDoc from "../components/PromiseDoc.jsx";
import CountUp from "../components/CountUp.jsx";
import Ring from "../components/Ring.jsx";
import { loadEvents, requestQuote, indicativePremium, pricerConfigured } from "../lib/pricer.js";
import { buyCover } from "../lib/wallet.js";
import { txUrl } from "../lib/config.js";
import { usd, pct, cents, when, sportOf, isChampionship, isSecondHalf, phase } from "../lib/format.js";

export function verifyLink(policyId, { ticker, label, merchant }) {
  const q = new URLSearchParams();
  if (ticker) q.set("t", ticker);
  if (label) q.set("l", label);
  if (merchant) q.set("m", merchant);
  return `${location.origin}${location.pathname}#/p/${policyId}?${q}`;
}

const coverable = (c) => c.marketState === "open" && Number(c.prices?.bestAsk) > 0 && Number(c.prices?.bestAsk) <= 0.5 && !/-D$/.test(c.instrumentSymbol);
const shortTitle = (e) => (isChampionship(e) ? e.title.replace(/^\d{4}\s*/, "the ").replace(/Pro Basketball Champion/i, "NBA title") : e.title);
const byAsk = (a, b) => Number(a.prices.bestAsk) - Number(b.prices.bestAsk);

/** Full-screen picker: one list of games, teams inline. Esc or backdrop closes. */
function Picker({ events, now, onPick, onClose }) {
  const [q, setQ] = useState("");
  const input = useRef(null);
  useEffect(() => {
    input.current?.focus();
    const k = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    window.__lenis?.stop();
    return () => { window.removeEventListener("keydown", k); window.__lenis?.start(); };
  }, [onClose]);
  const list = events
    .filter((e) => !e.parentTicker && phase(e, now) !== "done" && e.contracts.some(coverable))
    .filter((e) => !q || (e.title + " " + e.contracts.map((c) => c.label).join(" ")).toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="sheet" role="dialog" aria-modal="true" aria-label="Choose a team" onClick={onClose}>
      <div className="sheet-card" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <input ref={input} className="sheet-search" placeholder="Search a team or game" value={q} onChange={(e) => setQ(e.target.value)} />
          <button className="btn ghost" onClick={onClose}>Close</button>
        </div>
        <div className="sheet-list" data-lenis-prevent>
          {list.map((e) => (
            <div className={`sheet-row ${isChampionship(e) ? "stack" : ""}`} key={e.ticker}>
              <div className="sheet-game">
                <span>{e.title}</span>
                <span className="faint">{isChampionship(e) ? "Season" : `${sportOf(e)}, ${when(e.startTime)}`}</span>
              </div>
              <div className="sheet-teams">
                {e.contracts.filter(coverable).sort(byAsk).slice(0, isChampionship(e) ? 8 : 3).map((c) => (
                  <button key={c.instrumentSymbol} className="sheet-team" onClick={() => onPick(e.ticker, c.instrumentSymbol)}>
                    {c.label} <span className="num faint">{cents(c.prices.bestAsk)}</span>
                  </button>
                ))}
              </div>
            </div>
          ))}
          {list.length === 0 && <p className="muted">No open long shots match.</p>}
        </div>
      </div>
    </div>
  );
}

export default function PromisePage({ account, onConnect }) {
  const [data, setData] = useState(null);
  const [eventTicker, setEventTicker] = useState(null);
  const [symbol, setSymbol] = useState(null);
  const [payout, setPayout] = useState(5000);
  const [merchant, setMerchant] = useState("");
  const [quote, setQuote] = useState(null);
  const [quoteAt, setQuoteAt] = useState(0);
  const [busy, setBusy] = useState(null);
  const [err, setErr] = useState(null);
  const [done, setDone] = useState(null);
  const [picking, setPicking] = useState(false);
  const [details, setDetails] = useState(false);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    loadEvents().then((d) => {
      setData(d);
      const pick = d.events.find((e) => e.ticker === "NFL-2611221800-ARI-KC-M") ?? d.events.find((e) => !e.parentTicker && phase(e) === "pre" && e.contracts.some(coverable));
      if (pick) {
        setEventTicker(pick.ticker);
        setSymbol(pick.contracts.filter(coverable).sort(byAsk)[0]?.instrumentSymbol ?? null);
      }
    });
  }, []);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => { setQuote(null); setErr(null); }, [symbol, payout, eventTicker]);

  const events = data?.events ?? [];
  const byTicker = useMemo(() => Object.fromEntries(events.map((e) => [e.ticker, e])), [events]);
  const event = byTicker[eventTicker];
  const parent = event?.parentTicker ? byTicker[event.parentTicker] : event;
  const half = parent ? events.find((e) => e.parentTicker === parent.ticker && isSecondHalf(e)) : null;
  const onHalf = !!half && event?.ticker === half.ticker;
  const contract = event?.contracts.find((c) => c.instrumentSymbol === symbol);
  const ask = Number(contract?.prices?.bestAsk);
  const ph = event ? phase(event, now) : "pre";
  const indicative = contract && ask > 0 ? indicativePremium({ payout, ask }) : null;
  const b = quote?.breakdown;
  const premium = b?.premium ?? indicative?.premium;
  const secsLeft = quote ? Math.max(0, Number(quote.quote.expiry) - Math.floor(now / 1000)) : 0;

  function toggleHalf() {
    const target = onHalf ? parent : half;
    if (!target) return;
    const same = target.contracts.find((c) => c.label === contract?.label && coverable(c));
    setEventTicker(target.ticker);
    setSymbol(same?.instrumentSymbol ?? target.contracts.filter(coverable).sort(byAsk)[0]?.instrumentSymbol ?? null);
  }

  async function getQuote() {
    setErr(null);
    if (!account) return onConnect();
    setBusy("Pricing");
    try {
      setQuote(await requestQuote({ eventTicker: event.ticker, instrumentSymbol: symbol, payoutUsdc: payout, buyer: account }));
      setQuoteAt(Math.floor(Date.now() / 1000));
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(null);
    }
  }

  async function seal() {
    setErr(null);
    try {
      const r = await buyCover(account, quote, (s) => setBusy(s));
      setDone({ ...r, label: contract.label, ticker: event.ticker, premium: b.premium });
      setQuote(null);
    } catch (e) {
      setErr(e.shortMessage ?? e.message);
    } finally {
      setBusy(null);
    }
  }

  if (done) {
    const link = verifyLink(done.policyId, { ticker: done.ticker, label: done.label, merchant });
    return (
      <section className="composer done">
        <p className="composer-kicker">Sealed on Arc</p>
        <div className="done-doc">
          <PromiseDoc merchant={merchant} team={done.label} eventTitle={event?.title} payout={payout} policyId={done.policyId} status="locked" verifyUrl={link}
            lines={[["Payout locked", usd(payout)], ["Premium paid", usd(done.premium)]]} />
        </div>
        <div className="composer-actions">
          <a className="btn primary big" href={`#/p/${done.policyId}?${new URLSearchParams({ t: done.ticker, l: done.label, ...(merchant ? { m: merchant } : {}) })}`}>Open the proof page</a>
          <a className="btn ghost big" href={txUrl(done.hash)} target="_blank" rel="noreferrer">Transaction</a>
        </div>
      </section>
    );
  }

  const amount = payout.toLocaleString("en-US");
  return (
    <section className="composer">
      <p className="composer-kicker reveal">
        <span className={`dot ${data?.live ? "live" : "warn"}`} />
        {data ? (data.live ? "Live prices from Gemini" : "Gemini prices, captured Nov 19") : "Loading markets"}
      </p>

      <h1 className="composer-line reveal">
        If{" "}
        <button className="token" onClick={() => setPicking(true)} aria-label="Change team">{contract?.label ?? "your team"}</button>{" "}
        {event && isChampionship(event) ? <>wins {shortTitle(event)},</> : onHalf ? <>wins the 2nd half,</> : <>wins,</>} it’s <em>on us.</em>
        <br />
        Up to{" "}
        <label className="token token-amount">
          <span className="sr-only">Payout in USDC</span>$
          <span className="autosize">
            <span aria-hidden="true">{amount || "0"}</span>
            <input inputMode="numeric" size={1} value={amount}
              onChange={(e) => setPayout(Math.min(1e7, Number(e.target.value.replace(/[^0-9]/g, "")) || 0))} />
          </span>
        </label>
        .
      </h1>

      <div className="composer-meta reveal">
        <span>{event ? (isChampionship(event) ? "Season-long" : `${parent?.title}, ${when(parent?.startTime)}`) : ""}</span>
        {half && (
          <button className={`linkish ${onHalf ? "on" : ""}`} onClick={toggleHalf}>
            {onHalf ? "Back to full game" : "Halftime comeback"}
          </button>
        )}
      </div>

      <div className="composer-price reveal">
        <div>
          <div className="price-label">{b ? "Premium, signed" : "Premium"}</div>
          <div className="price-value"><CountUp value={premium} format={(x) => usd(x)} /></div>
          <div className="price-sub">{premium ? `${pct(premium / payout)} of the payout` : " "}</div>
        </div>
        <div className="composer-cta">
          {quote ? (
            <>
              <button className="btn primary big" onClick={seal} disabled={!!busy || secsLeft === 0}>
                {busy ? `${busy}…` : secsLeft === 0 ? "Quote expired" : "Seal the promise"}
              </button>
              <span className="countdown meta"><Ring left={secsLeft} total={Math.max(1, Number(quote.quote.expiry) - quoteAt)} />{secsLeft}s</span>
            </>
          ) : (
            <button className="btn primary big" onClick={getQuote} disabled={!!busy || !contract || !(payout > 0) || ph === "done" || !pricerConfigured()}>
              {busy ? `${busy}…` : !account ? "Connect to quote" : ph === "live" ? "Quote live" : "Get quote"}
            </button>
          )}
        </div>
      </div>
      {err && <p className="err composer-err" role="alert">{err}</p>}

      <button className="linkish composer-more" onClick={() => setDetails((v) => !v)} aria-expanded={details}>
        {details ? "Hide details" : "How it’s priced"}
      </button>
      {details && (
        <div className="composer-details">
          <div className="row"><span className="muted">Gemini price</span><span className="num">{cents(b?.pExec ?? indicative?.p)} per contract</span></div>
          <div className="row"><span className="muted">Hedge cost</span><span className="num">{usd(b?.hedgeCost ?? indicative?.hedge)}</span></div>
          <div className="row"><span className="muted">Buffer and capacity</span><span className="num">{usd(b ? b.buffer + b.utilizationSurcharge : indicative ? indicative.buffer + indicative.surcharge : null)}</span></div>
          <div className="row"><span className="muted">Capital charge</span><span className="num">{usd(b?.capitalCharge ?? indicative?.capital)}</span></div>
          <label className="row"><span className="muted">Name on the promise</span>
            <input className="inline-input" placeholder="Your bar" value={merchant} onChange={(e) => setMerchant(e.target.value.slice(0, 40))} />
          </label>
          {!pricerConfigured() && <p className="faint">Pricer offline. This is an estimate.</p>}
        </div>
      )}

      {picking && (
        <Picker events={events} now={now} onClose={() => setPicking(false)}
          onPick={(t, s) => { setEventTicker(t); setSymbol(s); setPicking(false); }} />
      )}
    </section>
  );
}
