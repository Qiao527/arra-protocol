import { useEffect, useMemo, useState } from "react";
import { readVault, readPolicies, readEvent, vaultLogs, eventIdOf } from "../lib/chain.js";
import { deposit, withdrawMax, lpPosition, usdcBalance } from "../lib/wallet.js";
import { loadEvents } from "../lib/pricer.js";
import snapshot from "../data/snapshot.json";
import { txUrl, STATE, VOID_OUTCOME, deploymentInfo } from "../lib/config.js";
import { usd, pct, short, prettyTicker } from "../lib/format.js";
import { ArrowRight, Spinner } from "../components/Icons.jsx";

function knownTickers(events) {
  const extra = ["DEMO-UNDERDOG", "DEMO-CHAMP", "NFL-2611221800-ARI-KC-M", "NFL-2611221800-ARI-KC-2HM", deploymentInfo.sandboxHedgeRun?.market?.eventTicker].filter(Boolean);
  const map = {};
  for (const e of snapshot.events) map[eventIdOf(e.ticker)] = e; // games outside the live list (e.g. Sunday's demo game)
  for (const e of events) map[eventIdOf(e.ticker)] = e;
  for (const t of extra) map[eventIdOf(t)] ??= { ticker: t, title: t.startsWith("DEMO") ? `${t} (mock book)` : prettyTicker(t), contracts: [] };
  // label the outcome the recorded runs actually used
  const run = deploymentInfo.sandboxHedgeRun?.market;
  if (run) {
    const e = map[eventIdOf(run.eventTicker)];
    if (e && !e.contracts?.[run.outcome]) { e.contracts = [...(e.contracts ?? [])]; e.contracts[run.outcome] = { label: run.label }; }
  }
  return map;
}

export default function DeskPage({ account, onConnect }) {
  const [vault, setVault] = useState(null);
  const [rows, setRows] = useState(null);
  const [hedges, setHedges] = useState([]);
  const [names, setNames] = useState({});
  const [pos, setPos] = useState(null);
  const [amt, setAmt] = useState("10");
  const [busy, setBusy] = useState(null);
  const [msg, setMsg] = useState(null);
  const [showSettled, setShowSettled] = useState(false);

  async function load() {
    const v = await readVault();
    setVault(v);
    const pols = await readPolicies(v.policyCount);
    const ids = [...new Set(pols.map((p) => p.eventId))];
    const evs = await Promise.all(ids.map(readEvent));
    setRows(
      evs
        .map((e) => ({ ...e, policies: pols.filter((p) => p.eventId === e.eventId) }))
        .sort((a, b) => (a.state === 3) - (b.state === 3) || b.policies.at(-1).id - a.policies.at(-1).id)
    );
    vaultLogs("HedgeRecorded").then((h) => setHedges(h.sort((a, b) => b.time - a.time)));
  }
  useEffect(() => {
    load();
    loadEvents().then((d) => setNames(knownTickers(d.events)));
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (!account) return;
    Promise.all([lpPosition(account), usdcBalance(account)]).then(([p, bal]) => setPos({ ...p, bal }));
  }, [account, vault]);

  const open = rows?.filter((r) => r.state !== 3) ?? [];
  const insuredOpen = open.reduce((s, r) => s + r.insured, 0);
  const lockedOpen = open.reduce((s, r) => s + r.locked, 0);
  const utilization = vault && vault.totalAssets > 0 ? vault.totalLocked / vault.totalAssets : 0;

  async function act(fn, label) {
    setMsg(null);
    if (!account) return onConnect();
    try {
      const h = await fn((s) => setBusy(`${s}… confirm in wallet`));
      setMsg({ ok: `${label} confirmed`, h });
      await load();
    } catch (e) {
      setMsg({ err: e.shortMessage ?? e.message });
    } finally {
      setBusy(null);
    }
  }

  const label = (eventId, outcome) => {
    const e = names[eventId];
    if (outcome === VOID_OUTCOME) return "Void";
    return e?.contracts?.[outcome]?.label ?? `Outcome ${outcome}`;
  };

  const shown = rows?.filter((r) => showSettled || r.state !== 3) ?? [];
  const settledCount = rows?.filter((r) => r.state === 3).length ?? 0;
  const free = vault ? Math.max(0, vault.totalAssets - vault.totalLocked) : 0;

  return (
    <div className="desk">
      <header className="desk-head">
        <div>
          <h1 className="desk-title">Risk <em>desk</em></h1>
          <p className="desk-lede">The pool behind every promise, read live from Arc.</p>
        </div>
        <span className="chip"><span className="dot live" />Live, every 15 s</span>
      </header>

      <section className="card desk-hero">
        <div className="desk-nav">
          <span className="deal-k">Vault value</span>
          <span className="desk-nav-v num">{usd(vault?.totalAssets)}</span>
          <span className="desk-nav-sub">arLP share price <b className="num">{vault ? vault.sharePrice.toFixed(4) : "—"}</b></span>
        </div>
        <div className="desk-meter" aria-label={`${pct(utilization)} of the vault is locked`}>
          <div className="meter"><span style={{ width: `${Math.min(100, utilization * 100)}%` }} /></div>
          <div className="meter-legend">
            <span><i className="sw lock" />Locked {usd(vault?.totalLocked)}</span>
            <span><i className="sw free" />Free {usd(free)}</span>
          </div>
        </div>
        <div className="desk-kpis">
          <div><span className="deal-k">Promises backed</span><span className="kpi num">{usd(insuredOpen)}</span></div>
          <div><span className="deal-k">Per locked dollar</span><span className="kpi num">{lockedOpen > 0 ? `${(insuredOpen / lockedOpen).toFixed(1)}×` : "—"}</span></div>
          <div><span className="deal-k">Promises sold</span><span className="kpi num">{vault?.policyCount ?? "—"}</span></div>
        </div>
      </section>

      <div className="desk-grid">
        <section>
          <div className="desk-sec-head">
            <h2 className="desk-h2">Games on the book</h2>
            <span className="legend"><span><i className="sw owe" />Owed if it wins</span><span><i className="sw hedge" />Hedged on Gemini</span></span>
          </div>
          {!rows && <div className="skeleton" style={{ height: 160, borderRadius: 24 }} />}
          {rows?.length === 0 && <p className="muted">No promises yet.</p>}
          <div className="games">
            {shown.map((r) => {
              const max = Math.max(...r.liability, 1e-9);
              const name = names[r.eventId]?.title ?? short(r.eventId, 6);
              const settledLabel = r.state === 3 ? (r.winningOutcome === VOID_OUTCOME ? "Void" : `Won: ${label(r.eventId, r.winningOutcome)}`) : STATE[r.state];
              return (
                <article key={r.eventId} className="card gcard">
                  <div className="game-head">
                    <h3>{name}</h3>
                    <span className={`pill ${r.state === 3 ? "done" : r.state === 2 ? "live" : ""}`}>{settledLabel}</span>
                  </div>
                  <div className="game-bars">
                    {r.liability.map((l, i) =>
                      l > 0 ? (
                        <div className="gbar" key={i}>
                          <span className="gbar-l">{label(r.eventId, i)}</span>
                          <span className="gbar-t">
                            <span className="owe" style={{ width: `${(l / max) * 100}%` }} />
                            <span className="hedge" style={{ width: `${(r.hedged[i] / max) * 100}%` }} />
                          </span>
                          <span className="gbar-v num">{usd(l)}</span>
                        </div>
                      ) : null
                    )}
                  </div>
                  <div className="game-foot">
                    <div><span className="deal-k">Insured</span><b className="num">{usd(r.insured)}</b></div>
                    <div><span className="deal-k">Locked</span><b className="num">{usd(r.state === 3 ? 0 : r.locked)}</b></div>
                    <div><span className="deal-k">Worst unhedged</span><b className="num">{usd(r.worstUnhedged)}</b></div>
                  </div>
                </article>
              );
            })}
          </div>
          {settledCount > 0 && (
            <button className="chip settled-toggle" onClick={() => setShowSettled((v) => !v)}>
              {showSettled ? "Hide settled games" : `Show settled games (${settledCount})`}
            </button>
          )}

          <div className="desk-sec-head" style={{ marginTop: 56 }}>
            <h2 className="desk-h2">Hedges on Gemini</h2>
            <span className="faint">Filled quantity only, each with its order ID</span>
          </div>
          <div className="card tbl-card">
            <div className="tbl-wrap"><table className="tbl">
              <thead><tr><th>Game</th><th>Outcome</th><th className="r">Covered</th><th className="r">Gemini order</th></tr></thead>
              <tbody>
                {hedges.length === 0 && <tr><td colSpan={4} className="muted">No hedges recorded yet.</td></tr>}
                {hedges.map((h) => (
                  <tr key={h.txHash}>
                    <td>{names[h.eventId]?.title ?? short(h.eventId, 6)}</td>
                    <td>{label(h.eventId, Number(h.outcome))}</td>
                    <td className="r num">{usd(Number(h.payoutCovered) / 1e6)}</td>
                    <td className="r"><a className="mono-s" href={txUrl(h.txHash)} target="_blank" rel="noreferrer">{h.geminiOrderId}</a></td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          </div>
        </section>

        <aside className="desk-side">
          <div className="card lp">
            <h2 className="desk-h2">Provide liquidity</h2>
            <p className="desk-p">Earn the premiums. You can withdraw capital that isn’t backing an open promise.</p>
            {account && pos && (
              <div className="lp-pos">
                <div><span className="deal-k">Your position</span><b className="num">{usd(pos.assets)}</b></div>
                <div><span className="deal-k">Withdrawable</span><b className="num">{usd(pos.withdrawable)}</b></div>
                <div><span className="deal-k">Wallet</span><b className="num">{usd(pos.bal)}</b></div>
              </div>
            )}
            <label className="deal-k" htmlFor="dep">Deposit</label>
            <div className="deal-amount lp-amount">
              <span className="deal-cur">$</span>
              <input id="dep" size={1} inputMode="decimal" autoComplete="off" value={amt} onChange={(e) => setAmt(e.target.value.replace(/[^0-9.]/g, ""))} />
              <span className="deal-unit">USDC</span>
            </div>
            <div className="presets">
              {["10", "50", "100"].map((v) => <button key={v} type="button" className={`chip sm ${amt === v ? "on" : ""}`} onClick={() => setAmt(v)}>${v}</button>)}
            </div>
            <div className="lp-actions">
              <button className="btn primary big" disabled={!!busy || !(Number(amt) > 0)} onClick={() => act((s) => deposit(account, amt, s), "Deposit")}>
                {busy ? <><Spinner />{busy}</> : account ? <>Deposit<ArrowRight /></> : "Connect wallet"}
              </button>
              <button className="btn big" disabled={!!busy || !account} onClick={() => act((s) => withdrawMax(account, s), "Withdrawal")}>Withdraw max</button>
            </div>
            {msg?.ok && <p className="lp-msg ok">{msg.ok}. <a href={txUrl(msg.h)} target="_blank" rel="noreferrer">View transaction</a></p>}
            {msg?.err && <p className="lp-msg err" role="alert">{msg.err}</p>}
          </div>

          <div className="card rules">
            <h2 className="desk-h2">Rules the contract enforces</h2>
            <ul className="rules-list">
              <Rule ok title="Fully collateralized">USDC {usd(vault?.balance)} covers locked {usd(vault?.totalLocked)} plus owed {usd(vault?.pendingClaims)}</Rule>
              <Rule ok title={`Per-game cap, ${vault ? pct(vault.eventCapBps / 1e4, 0) : "—"} of value`}>Worst unhedged payout on any one game, checked at every sale</Rule>
              <Rule ok title="Netting across outcomes">Only one team can win, so the vault locks the largest payout</Rule>
              <Rule ok title={`Settlement quorum ${vault ? `${vault.settlerThreshold} of ${vault.settlerCount}` : ""}`}>Unanimous settles at once; otherwise a {vault?.disputeWindow ?? "—"} s dispute window</Rule>
              <Rule ok={!(vault?.hedgeReceivable > 0)} title={`Hedge proceeds in transit, ${usd(vault?.hedgeReceivable)}`}>Withdrawals pause until they are back from Gemini</Rule>
            </ul>
          </div>
        </aside>
      </div>
    </div>
  );
}

function Rule({ ok, title, children }) {
  return (
    <li>
      <span className={`rule-ic ${ok ? "ok" : "wait"}`} role="img" aria-label={ok ? "holds" : "pending"}>
        {ok ? <svg viewBox="0 0 20 20" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 10.5l3 3 7-7" /></svg> : <span className="spin" />}
      </span>
      <div><div className="rule-t">{title}</div><div className="rule-d">{children}</div></div>
    </li>
  );
}
