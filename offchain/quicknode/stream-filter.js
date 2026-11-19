// QuickNode Streams filter: Arc Testnet (chain ID 5042002), dataset "Logs" (or "Block with receipts").
// Paste this into the Stream's filter editor, set VAULT below, and point the destination
// webhook at the hedger: POST https://<your-host>/quicknode
//
// Keeps only ArraVault CoverPurchased logs, so the hedger reacts to new covers in real time
// instead of polling the RPC.

const VAULT = "0xYOUR_ARRA_VAULT_ADDRESS".toLowerCase();
// keccak256("CoverPurchased(uint256,address,bytes32,uint8,uint256,uint256)")
const COVER_PURCHASED = "0x55605d8a4a8d6c3b3bc9f0cf356d1bb6c180ba912be012ca470df7caa0a2ffe8";

function collectLogs(data) {
  // Handles both the plain "logs" dataset and "block with receipts" payloads.
  const out = [];
  const visit = (x) => {
    if (!x) return;
    if (Array.isArray(x)) return x.forEach(visit);
    if (x.topics && x.address) return out.push(x);
    if (x.logs) visit(x.logs);
    if (x.receipts) visit(x.receipts);
  };
  visit(data);
  return out;
}

function main(stream) {
  const logs = collectLogs(stream.data ?? stream);
  const matches = logs.filter(
    (l) => String(l.address).toLowerCase() === VAULT && String(l.topics?.[0]).toLowerCase() === COVER_PURCHASED
  );
  return matches.length ? { logs: matches } : null; // null = deliver nothing for this block
}
