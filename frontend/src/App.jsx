import { ArrowRight } from "./components/Icons.jsx";
import { useEffect, useState } from "react";
import PromisePage from "./pages/PromisePage.jsx";
import VerifyPage from "./pages/VerifyPage.jsx";
import DeskPage from "./pages/DeskPage.jsx";
import Hero from "./components/Hero.jsx";
import Ticker from "./components/Ticker.jsx";
import { connect, hasWallet } from "./lib/wallet.js";
import { VAULT, addrUrl } from "./lib/config.js";
import { short } from "./lib/format.js";

function parseHash() {
  const raw = location.hash.replace(/^#/, "") || "/";
  const [path, qs] = raw.split("?");
  const params = new URLSearchParams(qs ?? "");
  const m = path.match(/^\/p\/(\d+)/);
  if (m) return { page: "verify", policyId: Number(m[1]), params };
  if (path.startsWith("/verify")) return { page: "verify", policyId: null, params };
  if (path.startsWith("/desk")) return { page: "desk", params };
  return { page: "promise", params };
}

export default function App() {
  const [route, setRoute] = useState(parseHash);
  const [account, setAccount] = useState(null);
  const [walletErr, setWalletErr] = useState(null);

  useEffect(() => {
    const on = () => { setRoute(parseHash()); window.__lenis ? window.__lenis.scrollTo(0, { immediate: true }) : window.scrollTo(0, 0); };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  useEffect(() => {
    if (!hasWallet()) return;
    window.ethereum.request({ method: "eth_accounts" }).then((a) => a[0] && setAccount(a[0])).catch(() => {});
    const onAcc = (a) => setAccount(a[0] ?? null);
    window.ethereum.on?.("accountsChanged", onAcc);
    return () => window.ethereum.removeListener?.("accountsChanged", onAcc);
  }, []);

  async function onConnect() {
    setWalletErr(null);
    try { setAccount(await connect()); } catch (e) { setWalletErr(e.message); }
  }

  const nav = [
    ["promise", "#/", "Make a promise"],
    ["verify", "#/verify", "Verify"],
    ["desk", "#/desk", "Risk desk"],
  ];

  return (
    <>
    <div className={`shell shell-top ${route.page === "promise" ? "over" : ""}`}>
      <header className="top">
        <a className="brand" href="#/" aria-label="Arra home"><span className="brand-name">Arra</span></a>
        <nav className="nav" aria-label="Main">
          {nav.map(([k, href, label]) => (
            <a key={k} href={href} aria-current={route.page === k ? "page" : undefined}>{label}</a>
          ))}
        </nav>
        <div className="top-right">
          {account ? (
            <span className="chip"><span className="dot live" />{short(account)}</span>
          ) : (
            <button className="btn" onClick={onConnect}>Connect wallet</button>
          )}
        </div>
      </header>
      {walletErr && <p className="err" role="alert">{walletErr}</p>}
    </div>

      {route.page === "promise" && <Hero />}
      {route.page === "promise" && <Ticker />}
    <div className="shell">
      <main id="make" key={route.page} className={route.page === "promise" ? "on-promise" : undefined}>
        {route.page === "promise" && <PromisePage account={account} onConnect={onConnect} />}
        {route.page === "verify" && <VerifyPage policyId={route.policyId} params={route.params} account={account} />}
        {route.page === "desk" && <DeskPage account={account} onConnect={onConnect} />}
      </main>
    </div>

      {route.page === "promise" && (
        <section className="band" aria-label="How it works">
          <div className="band-inner">
          <div className="band-grid">
          <div>
          <p className="statement reveal">
            Four bars in four cities each promise their team wins the title. <span className="dim">Only one team can.</span> So
            the vault locks <b>one payout</b>, not four, and the premium for a long shot stays near <b>15%</b>.
          </p>
          <a className="band-link" href="#/desk">See it on the risk desk <ArrowRight /></a>
          </div>
          <figure className="netting-fig reveal" aria-label="Four promises of $5, one lock of $5">
            {[["New Orleans", "Pelicans"], ["Dallas", "Mavericks"], ["Indianapolis", "Pacers"], ["Cleveland", "Cavaliers"]].map(([city, team]) => (
              <div className="nf-row" key={city}>
                <span>{city}</span>
                <span className="nf-team">{team} win the title</span>
                <span className="nf-amt">$5</span>
              </div>
            ))}
            <svg className="nf-join" viewBox="0 0 40 200" preserveAspectRatio="none" aria-hidden="true">
              <path d="M0 25 C 24 25, 16 100, 40 100 M0 75 C 24 75, 20 100, 40 100 M0 125 C 24 125, 20 100, 40 100 M0 175 C 24 175, 16 100, 40 100" />
            </svg>
            <div className="nf-lock">
              <span className="nf-k">Vault locks</span>
              <span className="nf-v">$5</span>
              <span className="nf-k">NBA champion, Gemini</span>
            </div>
          </figure>
          </div>
          </div>
        </section>
      )}

    <div className="shell">
      <footer className="foot">
        <span className="meta">Arra<span className="sep" />Testnet prototype, no real money</span>
        <span className="meta">Vault <a href={addrUrl(VAULT)} target="_blank" rel="noreferrer" className="num">{short(VAULT, 6)}</a> on Arc<span className="sep" />Prices from Gemini Prediction Markets</span>
      </footer>
    </div>
    </>
  );
}
