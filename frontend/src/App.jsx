import { useEffect, useState } from "react";
import Logo from "./components/Logo.jsx";
import PromisePage from "./pages/PromisePage.jsx";
import VerifyPage from "./pages/VerifyPage.jsx";
import DeskPage from "./pages/DeskPage.jsx";
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
    const on = () => { setRoute(parseHash()); window.scrollTo(0, 0); };
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
    <div className="shell">
      <header className="top">
        <a className="brand" href="#/" aria-label="Arra home"><Logo /><span className="brand-name">Arra</span></a>
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

      <main>
        {route.page === "promise" && <PromisePage account={account} onConnect={onConnect} />}
        {route.page === "verify" && <VerifyPage policyId={route.policyId} params={route.params} account={account} />}
        {route.page === "desk" && <DeskPage account={account} onConnect={onConnect} />}
      </main>

      {route.page === "promise" && (
        <section className="how" aria-label="How it works">
          <div><div className="n">01</div><h4>Priced by the market</h4><p>Gemini's prediction-market order book says what the upset is worth. The pricer walks the book for your full size and signs a 60-second quote.</p></div>
          <div><div className="n">02</div><h4>Locked, not promised</h4><p>Your payout sits in USDC in a vault on Arc. One lock backs every team at once, because only one can win.</p></div>
          <div><div className="n">03</div><h4>Paid at the whistle</h4><p>Settlers vote Gemini's result with a hash of the raw response. Unanimous means you're paid in seconds; anyone can check it.</p></div>
        </section>
      )}

      <footer className="foot">
        <span>Arra · testnet prototype · no real money</span>
        <span>Vault <a href={addrUrl(VAULT)} target="_blank" rel="noreferrer" className="num">{short(VAULT, 6)}</a> on Arc · prices from Gemini Prediction Markets</span>
      </footer>
    </div>
  );
}
