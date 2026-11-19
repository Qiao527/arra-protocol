import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { usd } from "../lib/format.js";

/**
 * The promise as a paper document. `status`: "draft" | "quoted" | "locked" | "paid" | "void".
 */
export default function PromiseDoc({ merchant, team, eventTitle, payout, lines = [], status = "draft", verifyUrl, policyId, fine }) {
  const [qr, setQr] = useState(null);
  useEffect(() => {
    if (!verifyUrl) return setQr(null);
    QRCode.toDataURL(verifyUrl, { margin: 0, width: 224, color: { dark: "#1b1a17", light: "#ffffff" } }).then(setQr);
  }, [verifyUrl]);

  const sealed = status === "locked" || status === "paid";
  return (
    <article className={`promise ${sealed ? "pressed" : ""}`} aria-label="Promise">
      <div className="row">
        <div className="who">{merchant || "Your business"} promises</div>
        <div className="who num">{policyId != null ? `Promise #${policyId}` : status === "quoted" ? "Quote, signed" : "Draft"}</div>
      </div>
      <p className="vow">
        If <em>{team || "your team"}</em> wins, the tab is on us, up to <span className="num">{usd(payout, 0)}</span>.
      </p>
      <div className="lines">
        {eventTitle && (
          <div className="line">
            <span>Game</span>
            <span>{eventTitle}</span>
          </div>
        )}
        {lines.map(([k, val, cls]) => (
          <div className={`line ${cls ?? ""}`} key={k}>
            <span>{k}</span>
            <span className="num">{val}</span>
          </div>
        ))}
      </div>
      <div className="foot">
        <div className="fine">
          {fine ??
            (sealed
              ? "Backed by USDC locked on Arc. Scan to check it yourself: no account, no trust in us."
              : "Priced from Gemini Prediction Markets. The payout is locked in USDC the moment you seal it.")}
        </div>
        {qr ? (
          <div className="qr">
            <img src={qr} alt="QR code: verify this promise onchain" />
          </div>
        ) : (
          <div className={`seal ${sealed ? "stamp" : "pending"}`} aria-hidden="true">
            <div>
              <b>Arra</b>
              <small>{status === "paid" ? "PAID" : status === "void" ? "REFUNDED" : sealed ? "LOCKED" : "UNSEALED"}</small>
            </div>
          </div>
        )}
      </div>
    </article>
  );
}
