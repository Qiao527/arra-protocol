import { useEffect, useState } from "react";
import PromiseDoc from "../components/PromiseDoc.jsx";
import { readPolicy, readEvent, readVault, vaultLogs, eventIdOf } from "../lib/chain.js";
import { claim } from "../lib/wallet.js";
import { VAULT, addrUrl, txUrl, STATE, VOID_OUTCOME } from "../lib/config.js";
import { usd, short, prettyTicker } from "../lib/format.js";

function Check({ state, title, children }) {
  const icon = state === "ok" ? "✓" : state === "no" ? "!" : "…";
  return (
    <li>
      <span className={`tick ${state}`} aria-label={state === "ok" ? "passed" : state === "no" ? "failed" : "pending"}>{icon}</span>
      <div>
        <div>{title}</div>
        {children && <div className="d">{children}</div>}
      </div>
    </li>
  );
}

export default function VerifyPage({ policyId, params, account }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [lookup, setLookup] = useState("");
  const [claiming, setClaiming] = useState(false);
  const ticker = params.get("t");
  const label = params.get("l");
  const merchant = params.get("m");

  async function load() {
    try {
      const vault = await readVault();
      if (policyId >= vault.policyCount) throw new Error(`No promise #${policyId} on this vault yet (${vault.policyCount} sold so far).`);
      const policy = await readPolicy(policyId);
      const [event, hedges, settled] = await Promise.all([
        readEvent(policy.eventId),
        vaultLogs("HedgeRecorded", { eventId: policy.eventId }),
        vaultLogs("EventSettled", { eventId: policy.eventId }),
      ]);
      setD({ vault, policy, event, hedges: hedges.filter((h) => Number(h.outcome) === policy.outcome), settled: settled[0] });
    } catch (e) {
      setErr(e.shortMessage ?? e.message);
    }
  }
  useEffect(() => {
    if (policyId == null) return;
    setD(null);
    setErr(null);
    load();
    const t = setInterval(load, 8000);
    return () => clearInterval(t);
  }, [policyId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (policyId == null) {
    return (
      <div style={{ maxWidth: 560 }}>
        <h1 className="display">Check a promise.</h1>
        <p className="lede">Every Arra promise is a numbered policy on Arc. Enter its number, or scan the QR code on the table.</p>
        <form className="row" onSubmit={(e) => { e.preventDefault(); if (lookup !== "") location.hash = `#/p/${Number(lookup)}`; }}>
          <div className="amount" style={{ flex: 1 }}>
            <span className="num muted">#</span>
            <input inputMode="numeric" aria-label="Promise number" value={lookup} onChange={(e) => setLookup(e.target.value.replace(/\D/g, ""))} placeholder="0" />
          </div>
          <button className="btn primary big" type="submit">Verify</button>
        </form>
      </div>
    );
  }

  if (err) return <p className="err" role="alert">{err}</p>;
  if (!d) return <div className="stack" style={{ maxWidth: 640 }}><div className="skeleton" style={{ height: 260 }} /><div className="skeleton" style={{ height: 160 }} /></div>;

  const { vault, policy, event, hedges, settled } = d;
  const tickerOk = ticker ? eventIdOf(ticker) === policy.eventId : null;
  const lockedOk = event.state !== 3 ? event.locked + 1e-9 >= event.liability[policy.outcome] && event.liability[policy.outcome] + 1e-9 >= policy.payout : true;
  const solvent = vault.balance + vault.hedgeReceivable + 1e-9 >= vault.totalLocked + vault.pendingClaims;
  const hedgedAmt = event.hedged[policy.outcome] ?? 0;
  const voided = event.state === 3 && event.winningOutcome === VOID_OUTCOME;
  const won = event.state === 3 && !voided && event.winningOutcome === policy.outcome;
  const lost = event.state === 3 && !voided && !won;
  const status = voided ? "void" : won ? "paid" : "locked";
  const team = label ?? `Outcome ${policy.outcome}`;
  const isHolder = account && account.toLowerCase() === policy.holder.toLowerCase();

  async function doClaim() {
    setClaiming(true);
    try { await claim(account, policy.id); await load(); } catch (e) { setErr(e.shortMessage ?? e.message); } finally { setClaiming(false); }
  }

  return (
    <div className="grid-2">
      <section>
        <PromiseDoc
          merchant={merchant ?? short(policy.holder)}
          team={team}
          eventTitle={ticker ? prettyTicker(ticker) : short(policy.eventId, 6)}
          payout={policy.payout}
          policyId={policy.id}
          status={status}
          lines={[
            ["Payout", usd(policy.payout)],
            ["Premium paid", usd(policy.premium)],
            ["Status", voided ? "Void: premium refunded" : won ? (policy.claimed ? "Won: paid out" : "Won: payout owed") : lost ? "Settled: team lost" : STATE[event.state] === "Proposed" ? "Result proposed" : "Open, awaiting the game", "total"],
          ]}
          fine={merchant ? "Business name as stated by the merchant. Everything else on this page is read live from Arc." : "Read live from Arc. Nothing on this page comes from our servers."}
        />
        {won && !policy.claimed && (
          <div className="panel" style={{ marginTop: 16 }}>
            <h3>Payout is owed: {usd(policy.payout)}</h3>
            <p className="sub">Anyone can trigger it; the USDC always goes to the promise holder.</p>
            <button className="btn primary big" onClick={doClaim} disabled={!account || claiming}>{claiming ? "Paying…" : account ? (isHolder ? "Collect payout" : "Pay out to the holder") : "Connect a wallet to trigger"}</button>
          </div>
        )}
      </section>

      <aside>
        <h2 className="section">Proof of promise</h2>
        <p className="sub muted" style={{ marginTop: 0 }}>Live checks against the vault contract on Arc testnet. Refreshes every 8 seconds.</p>
        <div className="panel">
          <ul className="checks">
            <Check state="ok" title={`Promise #${policy.id} exists onchain`}>
              Holder <a href={addrUrl(policy.holder)} target="_blank" rel="noreferrer" className="mono-s">{short(policy.holder, 6)}</a> · vault <a href={addrUrl(VAULT)} target="_blank" rel="noreferrer" className="mono-s">{short(VAULT, 6)}</a>
            </Check>
            {tickerOk !== null && (
              <Check state={tickerOk ? "ok" : "no"} title={tickerOk ? `It covers the Gemini market ${ticker}` : "The market named in this link does not match the policy"}>
                <span className="mono-s">keccak256("{ticker}") = {short(policy.eventId, 8)}</span>
              </Check>
            )}
            <Check state={lockedOk ? "ok" : "no"} title={event.state === 3 ? "Collateral released at settlement" : `${usd(event.locked)} USDC locked for this game`}>
              {event.state !== 3 && <>This game's worst case is {usd(event.locked)}. Outcomes are mutually exclusive, so one lock backs {usd(event.insured)} of promises across all teams.</>}
            </Check>
            <Check state={solvent ? "ok" : "no"} title={solvent ? "The vault can pay every open promise at once" : "Vault under-collateralized"}>
              USDC held {usd(vault.balance)} ≥ locked {usd(vault.totalLocked)} + owed {usd(vault.pendingClaims)}
            </Check>
            <Check state={hedgedAmt > 0 ? "ok" : "wait"} title={hedgedAmt > 0 ? `${usd(hedgedAmt)} of this outcome hedged on Gemini` : "Not hedged yet (hedger runs above a size threshold)"}>
              {hedges.map((h) => (
                <div key={h.txHash}>
                  Gemini order <span className="mono-s">{h.geminiOrderId}</span> · <a href={txUrl(h.txHash)} target="_blank" rel="noreferrer">recorded onchain</a>
                </div>
              ))}
            </Check>
            <Check
              state={event.state === 3 ? "ok" : event.state === 2 ? "wait" : "wait"}
              title={
                event.state === 3
                  ? voided ? "Event voided (tie or cancellation): premiums refunded" : event.winningOutcome === policy.outcome ? `Settled: ${team} won` : `Settled: another outcome won (#${event.winningOutcome})`
                  : event.state === 2
                    ? `Result proposed (outcome ${event.winningOutcome}); dispute window open`
                    : `Settles from Gemini's result: ${vault.settlerThreshold}-of-${vault.settlerCount} settlers, unanimous is instant`
              }
            >
              {event.state === 3 && settled && (
                <>Evidence <span className="mono-s">{short(event.evidenceHash, 8)}</span> (hash of the raw Gemini response) · <a href={txUrl(settled.txHash)} target="_blank" rel="noreferrer">settlement tx</a></>
              )}
              {event.state !== 3 && <>Dispute window {vault.disputeWindow}s, guardian can veto a wrong result.</>}
            </Check>
          </ul>
        </div>
      </aside>
    </div>
  );
}
