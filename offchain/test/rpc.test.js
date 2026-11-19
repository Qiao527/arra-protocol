// The hosted pricer read ~2n+4 values per quote as separate RPC calls (64 for a 30-team event)
// and hit Arc's public RPC limit ("Request exceeds defined limit"). Reads are batched through
// Multicall3 on chains that have it.
import { test } from "node:test";
import assert from "node:assert/strict";

test("Arc testnet client batches contract reads through Multicall3", async () => {
  process.env.CHAIN_ID = "5042002";
  const { publicClient } = await import("../src/chain.js?arc");
  assert.ok(publicClient.chain.contracts?.multicall3, "chain knows Multicall3");
  assert.ok(publicClient.batch?.multicall, "readContract calls are aggregated");
});
