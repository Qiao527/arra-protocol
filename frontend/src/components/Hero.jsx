import { useEffect, useRef, useState } from "react";

const BEATS = [
  { h: "A promise is a liability.", p: "“If our team wins, it’s on us.” Great for a packed room. Ruinous if the upset actually happens." },
  { h: "Arra locks it in USDC.", p: "Priced from Gemini’s prediction-market order book, hedged on Gemini, held in a vault on Arc. One lock backs every team, because only one can win." },
  { h: "And pays it at the whistle.", p: "Settlers vote Gemini’s result with a hash of the raw response. Your customers scan a QR code and check it themselves." },
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
        <div className="hero3d-grain" aria-hidden="true" />
        <div className="hero3d-copy">
          <p className="hero3d-kicker num">Arra</p>
          <h1 className="hero3d-title" key={beat}>{BEATS[beat].h}</h1>
          <p className="hero3d-p" key={`p${beat}`}>{BEATS[beat].p}</p>
          <div className="hero3d-progress" aria-hidden="true">
            {BEATS.map((_, i) => <span key={i} className={i <= beat ? "on" : ""} />)}
          </div>
          {beat === 2 && (
            <button className="btn primary big hero3d-cta" onClick={() => document.getElementById("make")?.scrollIntoView({ behavior: "smooth" })}>Make a promise</button>
          )}
        </div>
        <div className="hero3d-scroll num" style={{ opacity: p < 0.05 ? 1 : 0 }}>Scroll</div>
      </div>
    </section>
  );
}
