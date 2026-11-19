// Scroll reveal: elements with .reveal rise in once when they enter the viewport.
// A MutationObserver picks up elements rendered later (route changes, data loading).
export function startReveal() {
  if (typeof window === "undefined") return;
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
    document.documentElement.classList.add("no-reveal");
    return;
  }
  const io = new IntersectionObserver(
    (entries) => entries.forEach((e) => { if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); } }),
    { rootMargin: "0px 0px -8% 0px", threshold: 0.08 }
  );
  const scan = () => document.querySelectorAll(".reveal:not(.in):not([data-ob])").forEach((el) => { el.dataset.ob = "1"; io.observe(el); });
  scan();
  new MutationObserver(scan).observe(document.body, { childList: true, subtree: true });
}
