export const usd = (x, d = 2) =>
  x == null || Number.isNaN(x) ? "—" : `$${Number(x).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d })}`;
export const pct = (x, d = 1) => (x == null || Number.isNaN(x) ? "—" : `${(x * 100).toFixed(d)}%`);
export const short = (h, n = 4) => (h ? `${h.slice(0, 2 + n)}…${h.slice(-n)}` : "");
export const cents = (p) => (p == null ? "—" : `${Math.round(Number(p) * 100)}¢`);

export function when(iso) {
  if (!iso) return "Season-long";
  const d = new Date(iso);
  return d.toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function sportOf(e) {
  const s = e.sportsMarket?.sport ?? "";
  const t = e.ticker ?? "";
  if (/^NFL|american_football/.test(t) && !t.startsWith("NCAAF")) return "NFL";
  if (t.startsWith("NCAAF")) return "College football";
  if (t.startsWith("NBA")) return "NBA";
  if (t.startsWith("NCAAM")) return "College hoops";
  if (t.startsWith("NHL")) return "NHL";
  return s ? s.replace(/_/g, " ") : "Other";
}

export const isChampionship = (e) => !e.startTime && (e.contracts?.length ?? 0) > 3;
export const isSecondHalf = (e) => /-2HM$|-2PM$/.test(e.ticker ?? "");

/** "pre" before start, "live" after start while Gemini keeps it open, "done" when no contract is open. */
export function phase(e, now = Date.now()) {
  const open = (e.contracts ?? []).some((c) => c.marketState === "open");
  if (!open) return "done";
  if (!e.startTime) return "pre";
  const start = Date.parse(e.startTime);
  if (now < start) return "pre";
  return now - start < 4 * 3600_000 ? "live" : "done";
}

/** Readable name from a Gemini ticker when we have no title: "NHL-2611200000-PHI-OTT-M" -> "NHL · PHI vs OTT". */
export function prettyTicker(t = "") {
  const m = t.match(/^([A-Z]+)-\d{10}-([A-Z0-9]+)-([A-Z0-9]+)-(\w+)$/);
  if (!m) return t;
  const kind = m[4] === "M" ? "" : m[4] === "2HM" ? " · 2nd half" : ` · ${m[4]}`;
  return `${m[1]} · ${m[2]} vs ${m[3]}${kind}`;
}
