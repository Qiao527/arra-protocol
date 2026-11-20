// Strict check of a zkTLS claim recorded in ArraResultProofs. The contract only checks that the
// expected URL and regex appear somewhere in the claim's parameters, so it also accepts claims that
// prove nothing about the winner: a regex with an extra `|` branch, an inverted match, Gemini's URL
// in a header while the request went elsewhere, or a redacted response. Here the parameters are
// parsed and every field must be exactly what a proof of the winner looks like.
export const GEMINI_EVENT_URL = "https://api.gemini.com/v1/prediction-markets/events/";
export const winnerRegex = (sym) => `"instrumentSymbol":"${sym}"[^{}]*?"resolutionSide":"yes"`;

export function checkClaim({ eventTicker, winningSymbol, provider, parameters }) {
  const fail = (why) => ({ ok: false, why });
  if (provider !== "http") return fail("not an http claim");
  let p;
  try {
    p = JSON.parse(parameters);
  } catch {
    return fail("claim parameters are not JSON");
  }
  if (p.url !== GEMINI_EVENT_URL + eventTicker) return fail("the request did not go to Gemini's endpoint for this event");
  if (p.method !== "GET") return fail("the request was not a GET");
  const m = p.responseMatches;
  const exact = Array.isArray(m) && m.length === 1 && Object.keys(m[0]).sort().join() === "type,value" && m[0].type === "regex" && m[0].value === winnerRegex(winningSymbol);
  if (!exact) return fail("the response check is not exactly the winner pattern");
  if (p.responseRedactions !== undefined && !(Array.isArray(p.responseRedactions) && p.responseRedactions.length === 0)) return fail("the response was redacted");
  return { ok: true };
}
