// The committed ABI (offchain/abi/ArraVault.json) lets the pricer run on hosts without Foundry.
// It must match the compiled contract exactly: CI runs `forge build` before these tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const committed = new URL("../abi/ArraVault.json", import.meta.url);
const compiled = new URL("../../out/ArraVault.sol/ArraVault.json", import.meta.url);

test("committed ABI matches the compiled contract (run `npm run abi` after contract changes)", () => {
  assert.ok(fs.existsSync(committed), "offchain/abi/ArraVault.json missing: run npm run abi");
  if (!fs.existsSync(compiled)) return; // no forge build here (e.g. a Node-only host)
  assert.deepEqual(JSON.parse(fs.readFileSync(committed, "utf8")).abi, JSON.parse(fs.readFileSync(compiled, "utf8")).abi);
});

test("chain.js honours ARRA_ABI_PATH, so a host without out/ can use the committed copy", async () => {
  const os = await import("node:os");
  const path = await import("node:path");
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "arra-abi-")), "abi.json");
  fs.writeFileSync(tmp, JSON.stringify({ abi: [{ type: "function", name: "markerFromAbiPath", inputs: [], outputs: [], stateMutability: "view" }] }));
  process.env.ARRA_ABI_PATH = tmp;
  const { vaultAbi } = await import("../src/chain.js?abi-test");
  assert.ok(vaultAbi.some((x) => x.name === "markerFromAbiPath"));
});
