import { useEffect, useRef, useState } from "react";

const reduced = () => typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Counts from the previous value to the new one (400 ms, ease-out). Formats with `format`. */
export default function CountUp({ value, format = (x) => x.toFixed(2), ms = 450 }) {
  const [shown, setShown] = useState(value);
  const from = useRef(value);
  useEffect(() => {
    if (value == null || Number.isNaN(value)) return setShown(value);
    if (reduced() || from.current == null) { from.current = value; return setShown(value); }
    const a = from.current, t0 = performance.now();
    let raf;
    const tick = (t) => {
      const k = Math.min(1, (t - t0) / ms);
      const e = 1 - (1 - k) ** 3;
      setShown(a + (value - a) * e);
      if (k < 1) raf = requestAnimationFrame(tick);
      else from.current = value;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, ms]);
  return <>{shown == null || Number.isNaN(shown) ? "—" : format(shown)}</>;
}
