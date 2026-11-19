import { useEffect, useRef, useState } from "react";

const BEATS = [
  { h: <>“If we win, it’s <em>on us.</em>”</>, p: "A bar’s best promo, until the upset happens." },
  { h: <>Arra locks the payout in <em>USDC.</em></>, p: "Priced by Gemini’s prediction market. Held on Arc." },
  { h: <>Paid at the <em>whistle.</em></>, p: "Customers scan a QR code to see the money is there." },
];

/** Scroll-driven 3D hero. The WebGL scene loads lazily; without WebGL the copy still reads in order. */
export default function Hero() {
  const wrap = useRef(null);
  const canvas = useRef(null);
  const sceneRef = useRef(null);
  const [beat, setBeat] = useState(0);
  const [p, setP] = useState(0);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let disposed = false;
    const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const gl = (() => { try { return !!document.createElement("canvas").getContext("webgl2"); } catch { return false; } })();
    if (gl) {
      import("../three/sealScene.js").then(({ createSealScene }) => {
        if (disposed || !canvas.current) return;
        sceneRef.current = createSealScene(canvas.current, { reducedMotion });
        setReady(true);
      });
    }
    const onScroll = () => {
      const el = wrap.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const total = el.offsetHeight - window.innerHeight;
      const prog = Math.min(1, Math.max(0, -r.top / Math.max(1, total)));
      setP(prog);
      setBeat(prog < 0.33 ? 0 : prog < 0.66 ? 1 : 2);
      sceneRef.current?.setProgress(prog);
      if (r.bottom < 0) sceneRef.current?.pause(); else sceneRef.current?.resume();
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => { disposed = true; window.removeEventListener("scroll", onScroll); sceneRef.current?.dispose(); };
  }, []);

  return (
    <section className="hero3d" ref={wrap} aria-label="What Arra does">
      <div className="hero3d-sticky">
        <canvas ref={canvas} className={`hero3d-canvas ${ready ? "on" : ""}`} aria-hidden="true" />
        <div className="hero3d-copy">
          <h1 className="hero3d-title" key={beat}>{BEATS[beat].h}</h1>
          <p className="hero3d-p" key={`p${beat}`}>{BEATS[beat].p}</p>
          {beat === 2 && (
            <button className="btn primary big hero3d-cta" onClick={() => { const el = document.getElementById("make"); window.__lenis ? window.__lenis.scrollTo(el, { duration: 1.4 }) : el?.scrollIntoView({ behavior: "smooth" }); }}>
              Make a promise
            </button>
          )}
        </div>
        <div className="hero3d-foot">
          <span className="num">{String(beat + 1).padStart(2, "0")} / 03</span>
          <span style={{ opacity: p < 0.05 ? 1 : 0, transition: "opacity .4s" }}>Scroll</span>
        </div>
      </div>
    </section>
  );
}
