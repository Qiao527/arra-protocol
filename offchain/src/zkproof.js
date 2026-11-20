// zkTLS proofs of Gemini results (Reclaim zkFetch) and recording them in ArraResultProofs.
// Optional: everything here is skipped unless RECLAIM_ORG_TOKEN is set.
import fs from "node:fs";
import path from "node:path";
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet } from "viem/chains";
import abi from "../abi/ArraResultProofs.json" with { type: "json" };

/** ArraResultProofs on Arc testnet (also in deployments/arc-testnet.json). */
export const RESULT_PROOFS = "0xFBddD7f4c2319bFecBE126bf9b48e0186d82FB72";

export const eventUrl = (t) => `https://api.gemini.com/v1/prediction-markets/events/${t}`;
/** The regex ArraResultProofs pins: this contract, then resolutionSide yes, within one object. */
export const winnerRegex = (sym) => `"instrumentSymbol":"${sym}"[^{}]*?"resolutionSide":"yes"`;
export const zkEnabled = () => !!process.env.RECLAIM_ORG_TOKEN;

export async function proveResult(eventTicker, winningSymbol, { dir } = {}) {
  const { ReclaimClient } = await import("@reclaimprotocol/zk-fetch");
  const client = new ReclaimClient({ orgToken: process.env.RECLAIM_ORG_TOKEN, logs: process.env.RECLAIM_LOGS === "1" });
  const url = eventUrl(eventTicker);
  const proof = await client.zkFetch(
    url,
    { method: "GET", headers: { accept: "application/json" }, useTee: process.env.RECLAIM_USE_TEE === "1" },
    { responseMatches: [{ type: "regex", value: winnerRegex(winningSymbol) }] },
  );
  if (!proof?.claimData) throw new Error("zkFetch returned no proof");
  const out = path.join(dir ?? path.join(import.meta.dirname, "..", "evidence", "zk"), `${eventTicker}.json`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const doc = { eventTicker, winningSymbol, url, proof };
  fs.writeFileSync(out, JSON.stringify(doc, null, 2));
  return { file: out, doc };
}

export async function recordProof({ eventTicker, winningSymbol, proof }) {
  const key = process.env.PROOF_SENDER_KEY ?? process.env.OPERATOR_PRIVATE_KEY;
  if (!key) throw new Error("set OPERATOR_PRIVATE_KEY or PROOF_SENDER_KEY");
  const address = process.env.RESULT_PROOFS_ADDRESS ?? RESULT_PROOFS;
  const transport = http(process.env.RPC_URL ?? arcTestnet.rpcUrls.default.http[0]);
  const pub = createPublicClient({ chain: arcTestnet, transport });
  const wallet = createWalletClient({ chain: arcTestnet, transport, account: privateKeyToAccount(key) });
  const c = proof.claimData;
  const claim = { provider: c.provider, parameters: c.parameters, context: c.context, owner: c.owner, timestampS: c.timestampS, epoch: c.epoch };
  const args = [eventTicker, winningSymbol, claim, proof.signatures[0]];
  await pub.simulateContract({ address, abi, functionName: "prove", args, account: wallet.account });
  const hash = await wallet.writeContract({ address, abi, functionName: "prove", args });
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`prove tx reverted ${hash}`);
  return hash;
}
