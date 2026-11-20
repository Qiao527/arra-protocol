// Small stroke icons, 1.5px, drawn on a 20px grid. They inherit currentColor.
const base = { width: 18, height: 18, viewBox: "0 0 20 20", fill: "none", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true };

export const ArrowRight = (p) => (
  <svg className="ic ic-arrow" {...base} {...p}><path d="M4 10h12M11 5l5 5-5 5" /></svg>
);
export const Chevron = (p) => (
  <svg className="ic ic-chev" {...base} {...p}><path d="M6 8l4 4 4-4" /></svg>
);
export const Lock = (p) => (
  <svg className="ic" {...base} {...p}><rect x="4.5" y="9" width="11" height="8" rx="2" /><path d="M7 9V6.5a3 3 0 0 1 6 0V9" /></svg>
);
export const Search = (p) => (
  <svg className="ic" {...base} {...p}><circle cx="9" cy="9" r="5.5" /><path d="M13 13l4 4" /></svg>
);
export const Close = (p) => (
  <svg className="ic" {...base} {...p}><path d="M5 5l10 10M15 5L5 15" /></svg>
);
export const Spinner = () => <span className="spin" aria-hidden="true" />;
