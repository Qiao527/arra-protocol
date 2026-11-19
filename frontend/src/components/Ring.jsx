/** Countdown ring: fraction of the quote's life left. */
export default function Ring({ left, total }) {
  const r = 7, c = 2 * Math.PI * r;
  const f = total > 0 ? Math.max(0, Math.min(1, left / total)) : 0;
  return (
    <svg className="ring" viewBox="0 0 18 18" aria-hidden="true">
      <circle className="bg" cx="9" cy="9" r={r} />
      <circle className="fg" cx="9" cy="9" r={r} strokeDasharray={c} strokeDashoffset={c * (1 - f)} />
    </svg>
  );
}
