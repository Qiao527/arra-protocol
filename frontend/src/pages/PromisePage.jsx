import { useEffect, useMemo, useRef, useState } from "react";
import PromiseDoc from "../components/PromiseDoc.jsx";
import CountUp from "../components/CountUp.jsx";
import Ring from "../components/Ring.jsx";
import { ArrowRight, Chevron, Lock, Search, Close, Spinner } from "../components/Icons.jsx";
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
          <label className="input-wrap sheet-field"><Search />
            <input ref={input} className="sheet-search" placeholder="Search a team or game" value={q} onChange={(e) => setQ(e.target.value)} />
          </label>
          <button className="icon-btn" onClick={onClose} aria-label="Close"><Close /></button>
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
  const [payout, setPayout] = useState(5);
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
  // once signed, show exactly what the contract will charge (the quote's premium in USDC units)
  const signedPremium = quote ? Number(quote.quote.premium) / 1e6 : null;
  const premium = signedPremium ?? indicative?.premium;
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
      setDone({ ...r, label: contract.label, ticker: event.ticker, premium: Number(quote.quote.premium) / 1e6, payout: Number(quote.quote.payout) / 1e6 });
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
                <div className="done-doc">
          <PromiseDoc merchant={merchant} team={done.label} eventTitle={event?.title} payout={done.payout} policyId={done.policyId} status="locked" verifyUrl={link}
            lines={[["Payout locked", usd(done.payout)], ["Premium paid", usd(done.premium)]]} />
        </div>
        <div className="composer-actions">
          <a className="btn primary big" href={`#/p/${done.policyId}?${new URLSearchParams({ t: done.ticker, l: done.label, ...(merchant ? { m: merchant } : {}) })}`}>Open the proof page<ArrowRight /></a>
          <a className="btn ghost big" href={txUrl(done.hash)} target="_blank" rel="noreferrer">Transaction</a>
        </div>
      </section>
    );
  }

  const amount = payout.toLocaleString("en-US");
  // Testnet vault: about $55 of LP capital with a 10% per-game cap, so a promise above ~$5 per game
  // can't be backed (and $5,000 also exceeds the depth Gemini shows on most games).
  const PRESETS = [1, 2, 5];
  return (
    <section className="composer">
      <h1 className="composer-line">
        If{" "}
        <button className="token" onClick={() => setPicking(true)} aria-label={`Team: ${contract?.label ?? "choose"}. Change team`}>
          <span>{contract?.label ?? "your team"}</span><Chevron />
        </button>{" "}
        {event && isChampionship(event) ? <>wins {shortTitle(event)},</> : onHalf ? <>wins the 2nd half,</> : <>wins,</>} it’s <em>on&nbsp;us.</em>
      </h1>

      <div className="composer-meta">
        <span className="meta"><span className={`dot ${data?.live ? "live" : "warn"}`} />{event ? (isChampionship(event) ? "Season-long" : `${parent?.title}, ${when(parent?.startTime)}`) : "Loading markets"}</span>
        {half && (
          <button className={`chip ${onHalf ? "on" : ""}`} onClick={toggleHalf} aria-pressed={onHalf}>
            Halftime comeback
          </button>
        )}
      </div>

      <div className="deal">
        <div className="deal-cell">
          <label className="deal-k" htmlFor="payout">Payout if they win</label>
          <div className="deal-amount">
            <span className="deal-cur">$</span>
            <span className="autosize">
              <span aria-hidden="true">{amount || "0"}</span>
              <input id="payout" inputMode="numeric" size={1} value={amount} autoComplete="off"
                onChange={(e) => setPayout(Math.min(1e7, Number(e.target.value.replace(/[^0-9]/g, "")) || 0))} />
            </span>
            <span className="deal-unit">USDC</span>
          </div>
          <div className="presets" role="group" aria-label="Quick amounts">
            {PRESETS.map((v) => (
              <button key={v} type="button" className={`chip sm ${payout === v ? "on" : ""}`} onClick={() => setPayout(v)}>${v}</button>
            ))}
          </div>
        </div>

        <div className="deal-cell">
          <span className="deal-k">{b ? "Premium, signed" : "Premium"}</span>
          <div className="deal-v num"><CountUp value={premium} format={(x) => usd(x)} /></div>
          <div className="deal-sub">
            <span>{premium ? `${pct(premium / payout)} of the payout` : " "}</span>
            {ask > 0 && <span className="faint num">Gemini {cents(b?.pExec ?? ask)}</span>}
          </div>
        </div>

        <div className="deal-cell deal-cta">
          {quote ? (
            <>
              <button className="btn primary big" onClick={seal} disabled={!!busy || secsLeft === 0}>
                {busy ? <><Spinner />{busy}</> : secsLeft === 0 ? "Quote expired" : <><Lock />Seal the promise</>}
              </button>
              <span className="countdown meta"><Ring left={secsLeft} total={Math.max(1, Number(quote.quote.expiry) - quoteAt)} />Quote held {secsLeft}s</span>
            </>
          ) : (
            <button className="btn primary big" onClick={getQuote} disabled={!!busy || !contract || !(payout > 0) || ph === "done" || !pricerConfigured()}>
              {busy ? <><Spinner />{busy}</> : <>{!account ? "Connect to quote" : ph === "live" ? "Quote live" : "Get quote"}<ArrowRight /></>}
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
            <input className="field-input" placeholder="Your bar" value={merchant} onChange={(e) => setMerchant(e.target.value.slice(0, 40))} />
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
