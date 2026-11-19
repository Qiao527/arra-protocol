// Arc's public RPC refuses eth_getLogs over more than 10,000 blocks. A day after deploy the
// keeper's scan from FROM_BLOCK was ~100k blocks wide, so payouts after settlement threw.
import { test } from "node:test";
import assert from "node:assert/strict";

const { getLogsChunked } = await import("../src/chain.js");

function fakeClient({ head, logsAt = [] }) {
  const calls = [];
  return {
    calls,
    getBlockNumber: async () => head,
    getContractEvents: async ({ fromBlock, toBlock, eventName }) => {
      calls.push([fromBlock, toBlock]);
      if (toBlock === undefined || toBlock - fromBlock + 1n > 10_000n) throw new Error("eth_getLogs is limited to a 10,000 range");
      return logsAt.filter((b) => b >= fromBlock && b <= toBlock).map((blockNumber) => ({ blockNumber, eventName }));
    },
  };
}

test("a scan wider than the RPC limit is split into windows that cover every block exactly once", async () => {
  const client = fakeClient({ head: 1_104_768n, logsAt: [1_000_000n, 1_009_999n, 1_010_000n, 1_104_768n] });
  const logs = await getLogsChunked(client, { eventName: "CoverPurchased" }, { fromBlock: 1_000_000n });
  assert.deepEqual(logs.map((l) => l.blockNumber), [1_000_000n, 1_009_999n, 1_010_000n, 1_104_768n]);
  assert.equal(client.calls[0][0], 1_000_000n);
  assert.equal(client.calls.at(-1)[1], 1_104_768n);
  for (let i = 1; i < client.calls.length; i++) assert.equal(client.calls[i][0], client.calls[i - 1][1] + 1n);
});

test("a scan inside the limit is one call", async () => {
  const client = fakeClient({ head: 500n, logsAt: [7n] });
  const logs = await getLogsChunked(client, { eventName: "CoverPurchased" }, { fromBlock: 0n });
  assert.equal(client.calls.length, 1);
  assert.equal(logs.length, 1);
});
