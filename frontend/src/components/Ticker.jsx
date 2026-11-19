import { useEffect, useState } from "react";
import { loadEvents } from "../lib/pricer.js";
import { cents, isChampionship, phase } from "../lib/format.js";

/** Live Gemini long-shot prices on a slow loop. Edges fade out; hover pauses it. */
export default function Ticker() {
  const [items, setItems] = useState([]);
  const [live, setLive] = useState(false);
  useEffect(() => {
    loadEvents().then(({ events, live }) => {
      setLive(live);
      const out = [];
      for (const e of events) {
        if (e.parentTicker || phase(e) === "done") continue;
        const open = e.contracts.filter((c) => c.marketState === "open" && Number(c.prices?.bestAsk) > 0 && Number(c.prices?.bestAsk) <= 0.5);
        open.sort((a, b) => Number(a.prices.bestAsk) - Number(b.prices.bestAsk));
        for (const c of open.slice(0, isChampionship(e) ? 4 : 1)) out.push({ k: c.instrumentSymbol, team: c.label, price: c.prices.bestAsk, ctx: isChampionship(e) ? "title" : "to win" });
      }
      setItems(out.slice(0, 24));
    });
  }, []);
  if (!items.length) return <div className="ticker" aria-hidden="true" />;
  const row = (dup) => items.map((it) => (
    <span className="ticker-item" key={(dup ? "b" : "a") + it.k} aria-hidden={dup || undefined}>
      <span className="ticker-team">{it.team}</span>
      <span className="ticker-ctx">{it.ctx}</span>
      <span className="ticker-price num">{cents(it.price)}</span>
    </span>
  ));
  return (
    <div className="ticker" role="marquee" aria-label={`${live ? "Live" : "Captured"} Gemini prices for long shots`}>
      <span className="ticker-badge"><span className={`dot ${live ? "live" : "warn"}`} />Gemini</span>
      <div className="ticker-viewport">
        <div className="ticker-track" style={{ "--ticker-duration": `${items.length * 4}s` }}>
          {row(false)}{row(true)}
        </div>
      </div>
    </div>
  );
}
