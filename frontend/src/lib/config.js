import { arcTestnet } from "viem/chains";
import deployment from "../../../deployments/arc-testnet.json";
import vaultArtifact from "../../../offchain/abi/ArraVault.json";

export const chain = arcTestnet;
export const VAULT = deployment.arraVault;
export const USDC = deployment.usdc;
export const EXPLORER = deployment.explorer ?? "https://explorer.testnet.arc.io";
export const DEPLOY_TX = deployment.deployTx;
export const deploymentInfo = deployment;

/** Pricer service (live Gemini quotes). Build-time env wins, then the deployment file. */
export const PRICER_URL = (import.meta.env.VITE_PRICER_URL || deployment.pricerUrl || "").replace(/\/$/, "");

export const RESULT_PROOFS = deployment.resultProofs;
export const proofsAbi = [
  { type: "function", name: "proofOf", stateMutability: "view", inputs: [{ name: "eventId", type: "bytes32" }],
    outputs: [{ name: "identifier", type: "bytes32" }, { name: "attestor", type: "address" }, { name: "timestampS", type: "uint64" }, { name: "winningSymbolHash", type: "bytes32" }] },
];

export const vaultAbi = vaultArtifact.abi ?? vaultArtifact;

export const erc20Abi = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "o", type: "address" }, { name: "s", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "s", type: "address" }, { name: "v", type: "uint256" }], outputs: [{ type: "bool" }] },
];

export const STATE = ["None", "Open", "Proposed", "Settled"];
export const VOID_OUTCOME = 255;

export const txUrl = (h) => `${EXPLORER}/tx/${h}`;
export const addrUrl = (a) => `${EXPLORER}/address/${a}`;
