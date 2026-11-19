import { useEffect, useMemo, useState } from "react";
import { readVault, readPolicies, readEvent, vaultLogs, eventIdOf } from "../lib/chain.js";
import { deposit, withdrawMax, lpPosition, usdcBalance } from "../lib/wallet.js";
import { loadEvents } from "../lib/pricer.js";
import { txUrl, STATE, VOID_OUTCOME, deploymentInfo } from "../lib/config.js";
import { usd, pct, short, prettyTicker } from "../lib/format.js";

function knownTickers(events) {
  const extra = ["DEMO-UNDERDOG", "DEMO-CHAMP", deploymentInfo.sandboxHedgeRun?.market?.eventTicker].filter(Boolean);
  const map = {};
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

  return (
    <div>
      <div className="row" style={{ alignItems: "flex-end", marginBottom: 20, flexWrap: "wrap" }}>
        <div>
          <h1 className="display" style={{ marginBottom: 8 }} data-enter="1">Risk desk</h1>
          <p className="muted" style={{ margin: 0 }}>The pool that backs every promise. Read live from Arc.</p>
        </div>
        <span className="chip"><span className="dot live" />Arc testnet<span className="sep" />refreshes every 15s</span>
      </div>

      <div className="stats">
        <div className="stat"><div className="k">Vault NAV</div><div className="v">{usd(vault?.totalAssets)}</div><div className="h">USDC + hedge receivable − owed</div></div>
        <div className="stat"><div className="k">Locked for open promises</div><div className="v">{usd(vault?.totalLocked)}</div><div className="h">{pct(utilization)} of NAV</div></div>
        <div className="stat"><div className="k">Promises backed</div><div className="v">{usd(insuredOpen)}</div><div className="h">{lockedOpen > 0 ? `${(insuredOpen / lockedOpen).toFixed(1)}× per locked dollar` : "netting ratio"}</div></div>
        <div className="stat"><div className="k">arLP share price</div><div className="v">{vault ? vault.sharePrice.toFixed(4) : "—"}</div><div className="h">{vault ? `${vault.policyCount} promises sold` : ""}</div></div>
      </div>

      <div className="grid-2">
        <section>
          <div className="panel">
            <h3>Games on the book</h3>
            <p className="sub">Bars: payout owed if that outcome wins (white) and the part hedged on Gemini (green). The vault locks only the largest bar.</p>
            {!rows && <div className="skeleton" style={{ height: 120 }} />}
            {rows?.length === 0 && <p className="muted">No promises yet.</p>}
            <div className="stack">
              {rows?.map((r) => {
                const max = Math.max(...r.liability, 1e-9);
                const name = names[r.eventId]?.title ?? short(r.eventId, 6);
                const settledLabel = r.state === 3 ? (r.winningOutcome === VOID_OUTCOME ? "Void" : `Won: ${label(r.eventId, r.winningOutcome)}`) : STATE[r.state];
                return (
                  <div key={r.eventId} style={{ paddingBottom: 14, borderBottom: "1px solid var(--line-soft)" }}>
                    <div className="row" style={{ marginBottom: 8 }}>
                      <b style={{ fontWeight: 500 }}>{name}</b>
                      <span className={`badge ${r.state === 2 ? "live" : ""}`}>{settledLabel}</span>
                    </div>
                    <div className="bars">
                      {r.liability.map((l, i) =>
                        l > 0 ? (
                          <div className="bar" key={i}>
                            <span className="muted" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label(r.eventId, i)}</span>
                            <span className="track">
                              <span className="fill" style={{ width: `${(l / max) * 100}%` }} />
                              <span className="fill hedge" style={{ width: `${(r.hedged[i] / max) * 100}%` }} />
                            </span>
                            <span className="num r" style={{ textAlign: "right" }}>{usd(l)}</span>
                          </div>
                        ) : null
                      )}
                    </div>
                    <div className="netting" style={{ marginTop: 8 }}>
                      <span>Insured <b>{usd(r.insured)}</b></span><span className="sep" /><span>Locked <b>{usd(r.state === 3 ? 0 : r.locked)}</b></span><span className="sep" /><span>Worst unhedged <span className="num">{usd(r.worstUnhedged)}</span></span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="panel">
            <h3>Hedges on Gemini</h3>
            <p className="sub">Every hedge is recorded onchain with its Gemini order ID. Only filled quantity is recorded.</p>
            <table className="tbl">
              <thead><tr><th>Game</th><th>Outcome</th><th className="r">Covered</th><th>Gemini order</th></tr></thead>
              <tbody>
                {hedges.length === 0 && <tr><td colSpan={4} className="muted">No hedges recorded yet.</td></tr>}
                {hedges.map((h) => (
                  <tr key={h.txHash}>
                    <td>{names[h.eventId]?.title ?? short(h.eventId, 6)}</td>
                    <td>{label(h.eventId, Number(h.outcome))}</td>
                    <td className="r num">{usd(Number(h.payoutCovered) / 1e6)}</td>
                    <td><a className="mono-s" href={txUrl(h.txHash)} target="_blank" rel="noreferrer">{h.geminiOrderId}</a></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <aside>
          <div className="panel">
            <h3>Provide liquidity</h3>
            <p className="sub">Earn the premiums. Withdrawals are limited to capital not backing open promises, and pause while hedge proceeds are in transit.</p>
            {account && pos && (
              <div className="stack" style={{ marginBottom: 14 }}>
                <div className="row"><span className="muted">Your position</span><span className="num">{usd(pos.assets)}</span></div>
                <div className="row"><span className="muted">Withdrawable now</span><span className="num">{usd(pos.withdrawable)}</span></div>
                <div className="row"><span className="muted">Wallet USDC</span><span className="num">{usd(pos.bal)}</span></div>
              </div>
            )}
            <label className="field" htmlFor="dep">Deposit (USDC)</label>
            <div className="amount"><span className="num muted">$</span><input id="dep" inputMode="decimal" value={amt} onChange={(e) => setAmt(e.target.value.replace(/[^0-9.]/g, ""))} /></div>
            <div className="row" style={{ marginTop: 12 }}>
              <button className="btn primary" disabled={!!busy || !(Number(amt) > 0)} onClick={() => act((s) => deposit(account, amt, s), "Deposit")}>{busy ?? (account ? "Deposit" : "Connect wallet")}</button>
              <button className="btn" disabled={!!busy || !account} onClick={() => act((s) => withdrawMax(account, s), "Withdrawal")}>Withdraw max</button>
            </div>
            {msg?.ok && <p className="muted" style={{ marginTop: 10 }}>{msg.ok}: <a href={txUrl(msg.h)} target="_blank" rel="noreferrer">tx</a></p>}
            {msg?.err && <p className="err" role="alert" style={{ marginTop: 10 }}>{msg.err}</p>}
          </div>

          <div className="panel">
            <h3>Risk rules, enforced by the contract</h3>
            <ul className="checks">
              <li><span className="tick ok">✓</span><div>Fully collateralized<div className="d">USDC {usd(vault?.balance)} vs locked {usd(vault?.totalLocked)} + owed {usd(vault?.pendingClaims)}</div></div></li>
              <li><span className="tick ok">✓</span><div>Per-game cap: {vault ? pct(vault.eventCapBps / 1e4, 0) : "—"} of NAV<div className="d">Worst unhedged payout on any one game, checked at every sale</div></div></li>
              <li><span className="tick ok">✓</span><div>Netting across outcomes<div className="d">Only one team can win, so the vault locks the largest payout, not the sum</div></div></li>
              <li><span className="tick ok">✓</span><div>Settlement quorum {vault ? `${vault.settlerThreshold}-of-${vault.settlerCount}` : ""}<div className="d">Unanimous settles instantly; otherwise a {vault?.disputeWindow}s dispute window with guardian veto</div></div></li>
              <li><span className={`tick ${vault?.hedgeReceivable > 0 ? "wait" : "ok"}`}>{vault?.hedgeReceivable > 0 ? "…" : "✓"}</span><div>Hedge proceeds in transit: {usd(vault?.hedgeReceivable)}<div className="d">LP withdrawals pause until swept back from Gemini</div></div></li>
            </ul>
          </div>
        </aside>
      </div>
    </div>
  );
}
