import { Fragment, useEffect, useRef, useState } from "react";
import { ArrowRight } from "./Icons.jsx";

// Each headline is a list of [text, emphasis] runs; words are masked and rise in one at a time.
const BEATS = [
  { h: [["“If we win, it’s"], ["on us.”", true]], p: "A bar’s best promo, until the upset happens." },
  { h: [["Arra locks the payout in"], ["USDC.", true]], p: "Priced by Gemini’s prediction market. Held on Arc." },
  { h: [["Paid at the"], ["whistle.", true]], p: "Customers scan a QR code to see the money is there." },
];

function Words({ runs }) {
  let i = 0;
  return runs.flatMap(([text, em]) =>
    text.split(" ").map((w) => {
      const k = i++;
      const inner = <span className="w-i" style={{ "--i": k }}>{w}</span>;
      return <Fragment key={k}>{k > 0 && " "}<span className="w">{em ? <em>{inner}</em> : inner}</span></Fragment>;
    }),
  );
}

const goMake = () => {
  const el = document.getElementById("make");
  window.__lenis ? window.__lenis.scrollTo(el, { duration: 1.6 }) : el?.scrollIntoView({ behavior: "smooth" });
};

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
          {BEATS.map((b, i) => (
            <div key={i} className={`beat ${i === beat ? "on" : i < beat ? "past" : ""}`} aria-hidden={i !== beat}>
              <h1 className="hero3d-title"><Words runs={b.h} /></h1>
              <p className="hero3d-p">{b.p}</p>
              {i === 2 && (
                <button className="btn primary big hero3d-cta" onClick={goMake} tabIndex={beat === 2 ? 0 : -1}>
                  Make a promise <ArrowRight />
                </button>
              )}
            </div>
          ))}
        </div>
        <div className="hero3d-foot">
          <span className="hero3d-count num">
            <span className="hero3d-n" key={beat}>{String(beat + 1).padStart(2, "0")}</span>
            <span className="faint"> / 03</span>
          </span>
          <span className="hero3d-progress" aria-hidden="true">
            {[0, 1, 2].map((i) => (
              <i key={i}><b style={{ transform: `scaleX(${Math.min(1, Math.max(0, p * 3 - i))})` }} /></i>
            ))}
          </span>
          <span className="hero3d-scroll" style={{ opacity: p < 0.05 ? 1 : 0 }}>Scroll</span>
        </div>
      </div>
    </section>
  );
}
