import "dotenv/config";
import { defineChain } from "viem";
import { arcTestnet } from "viem/chains"; // Arc testnet ships with viem (chain ID 5042002)

export { arcTestnet };

const env = (k, d) => process.env[k] ?? d;

export const config = {
  rpcUrl: env("RPC_URL", arcTestnet.rpcUrls.default.http[0]),
  chainId: Number(env("CHAIN_ID", "5042002")),
  vault: env("VAULT_ADDRESS"),
  operatorPk: env("OPERATOR_PRIVATE_KEY", env("ORACLE_PRIVATE_KEY")), // signs quotes, records hedges
  settlerPks: env("SETTLER_PRIVATE_KEYS", "").split(",").map((x) => x.trim()).filter(Boolean),
  port: Number(env("PORT", "8787")),

  // Pricing (see README "Economic design")
  hedgeBufferBps: Number(env("HEDGE_BUFFER_BPS", "500")), // b = 5%
  capitalChargeBps: Number(env("CAPITAL_CHARGE_BPS", "200")), // r = 2%
  surchargeKBps: Number(env("SURCHARGE_K_BPS", "2000")), // k = 20% at full utilization
  quoteTtlSec: Number(env("QUOTE_TTL_SEC", "60")),
  maxProbability: Number(env("MAX_PROBABILITY", "0.5")), // refuse coin-flip-or-worse covers

  // Gemini
  geminiBase: env("GEMINI_BASE", "https://api.gemini.com"),
  geminiSandboxBase: env("GEMINI_SANDBOX_BASE", "https://api.sandbox.gemini.com"),
  geminiKey: env("GEMINI_API_KEY"),
  geminiSecret: env("GEMINI_API_SECRET"),
  mockGemini: env("MOCK_GEMINI", "false") === "true",

  // Hedger
  hedgeThresholdUsdc: Number(env("HEDGE_THRESHOLD_USDC", "2000")),
  hedgerPort: Number(env("HEDGER_PORT", "8788")),
  quicknodeSecret: env("QUICKNODE_WEBHOOK_SECRET"), // optional shared secret header
};

export function chain() {
  if (config.chainId === arcTestnet.id) return arcTestnet;
  return defineChain({
    id: config.chainId,
    name: "Local",
    nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [config.rpcUrl] } },
  });
}
