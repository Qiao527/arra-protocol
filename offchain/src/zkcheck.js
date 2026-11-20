// Second source of truth for a settled event: the zkTLS proof recorded in ArraResultProofs.
// A Reclaim attestor signed that Gemini's server returned "<symbol> resolved yes" for this event.
// When the keeper's archived evidence bytes are gone (a restart lost them), this proof still lets
// anyone check the onchain winner against what Gemini actually served.
import { decodeFunctionData, keccak256, toBytes, isAddressEqual } from "viem";

export const GEMINI_EVENT_URL = "https://api.gemini.com/v1/prediction-markets/events/";

// Byte-for-byte copy of ArraResultProofs.expectedParameters(eventTicker, winningSymbol).
export const expectedParameters = (eventTicker, winningSymbol) =>
  '{"body":"","headers":{"User-Agent":"reclaim/0.0.1","accept":"application/json"},"method":"GET",' +
  '"responseMatches":[{"type":"regex","value":"\\"instrumentSymbol\\":\\"' +
  winningSymbol +
  '\\"[^{}]*?\\"resolutionSide\\":\\"yes\\""}],"responseRedactions":[],"url":"' +
  GEMINI_EVENT_URL +
  eventTicker +
  '"}';

export const proofsAbi = [
  { type: "function", name: "proofOf", stateMutability: "view", inputs: [{ name: "eventId", type: "bytes32" }],
    outputs: [{ name: "identifier", type: "bytes32" }, { name: "attestor", type: "address" }, { name: "timestampS", type: "uint64" }, { name: "winningSymbolHash", type: "bytes32" }] },
  { type: "function", name: "prove", stateMutability: "nonpayable",
    inputs: [
      { name: "eventTicker", type: "string" },
      { name: "winningSymbol", type: "string" },
      { name: "c", type: "tuple", components: [
        { name: "provider", type: "string" }, { name: "parameters", type: "string" }, { name: "context", type: "string" },
        { name: "owner", type: "address" }, { name: "timestampS", type: "uint32" }, { name: "epoch", type: "uint32" },
      ] },
      { name: "signature", type: "bytes" },
    ],
    outputs: [{ name: "eventId", type: "bytes32" }] },
  { type: "event", name: "ResultProven", inputs: [
    { name: "eventId", type: "bytes32", indexed: true }, { name: "eventTicker", type: "string", indexed: false },
    { name: "winningSymbol", type: "string", indexed: false }, { name: "identifier", type: "bytes32", indexed: false },
    { name: "attestor", type: "address", indexed: false }, { name: "timestampS", type: "uint64", indexed: false },
  ] },
];

/**
 * Pure check. `proof` is proofOf(eventId); `call` is the decoded prove() arguments from the
 * transaction that recorded it. Returns { pass, checks } like verifyEvidence.
 */
export function checkZkProof({ eventTicker, outcomes, winningOutcome, proof, call, trustedAttestors }) {
  const winner = Array.isArray(outcomes) ? outcomes[Number(winningOutcome)] : undefined;
  const [ticker, symbol, c] = call?.args ?? [];
  const checks = [
    { name: "a zkTLS proof is recorded for this event", ok: !!proof && !/^0x0+$/.test(proof.identifier) },
    { name: "the proof is for this event", ok: ticker === eventTicker },
    { name: "the proven winner is the onchain winner", ok: winner !== undefined && symbol === winner },
    { name: "stored winner hash matches", ok: !!proof && winner !== undefined && proof.winningSymbolHash === keccak256(toBytes(winner)) },
    { name: "claim is exactly a GET of Gemini's event endpoint matching the winner", ok: c?.provider === "http" && c?.parameters === expectedParameters(eventTicker, winner ?? "") },
    { name: "signed by a trusted Reclaim attestor", ok: !!proof && (trustedAttestors ?? []).some((a) => isAddressEqual(a, proof.attestor)) },
  ];
  return { pass: checks.every((x) => x.ok), checks };
}

/** IO: read proofOf, find the ResultProven tx, decode its calldata. Returns null if no proof. */
export async function loadZkProof({ client, address, deployTx, eventTicker }) {
  const eventId = keccak256(toBytes(eventTicker));
  const [identifier, attestor, timestampS, winningSymbolHash] = await client.readContract({ address, abi: proofsAbi, functionName: "proofOf", args: [eventId] });
  if (/^0x0+$/.test(identifier)) return null;
  const proof = { identifier, attestor, timestampS: Number(timestampS), winningSymbolHash };
  const from = (await client.getTransactionReceipt({ hash: deployTx })).blockNumber;
  const head = await client.getBlockNumber({ cacheTime: 0 });
  let hash = null;
  for (let a = from; a <= head && !hash; a += 10_000n) {
    const b = a + 9_999n < head ? a + 9_999n : head;
    const logs = await client.getContractEvents({ address, abi: proofsAbi, eventName: "ResultProven", args: { eventId }, fromBlock: a, toBlock: b });
    if (logs.length) hash = logs[logs.length - 1].transactionHash;
  }
  if (!hash) return { proof, call: null };
  const tx = await client.getTransaction({ hash });
  const call = decodeFunctionData({ abi: proofsAbi, data: tx.input });
  return { proof, call, tx: hash };
}
