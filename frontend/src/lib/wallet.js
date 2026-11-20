// Injected wallet (MetaMask, Rabby, Coinbase Wallet...). Arc testnet is added on first connect.
import { createWalletClient, custom, numberToHex, parseUnits } from "viem";
import { chain, VAULT, USDC, vaultAbi, erc20Abi } from "./config.js";
import { client } from "./chain.js";

export const hasWallet = () => typeof window !== "undefined" && !!window.ethereum;

async function ensureArc() {
  const id = numberToHex(chain.id);
  // Already on Arc: don't ask. Some wallets refuse a switch request (4100) when the site has no
  // permission for the network, even when the user has picked Arc by hand.
  const current = await window.ethereum.request({ method: "eth_chainId" }).catch(() => null);
  if (current && BigInt(current) === BigInt(chain.id)) return;
  try {
    await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: id }] });
  } catch (err) {
    if (err?.code === 4100 || err?.code === 4001) {
      throw new Error("Your wallet didn't allow switching to Arc Testnet. Pick Arc Testnet in your wallet's network menu, then try again.");
    }
    if (err?.code !== 4902 && !/Unrecognized|not added/i.test(err?.message ?? "")) throw err;
    await window.ethereum.request({
      method: "wallet_addEthereumChain",
      params: [{
        chainId: id,
        chainName: "Arc Testnet",
        nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
        rpcUrls: chain.rpcUrls.default.http,
        blockExplorerUrls: ["https://explorer.testnet.arc.io"],
      }],
    });
  }
}

export async function connect() {
  if (!hasWallet()) throw new Error("No browser wallet found. Install MetaMask or Rabby to sign on Arc.");
  const [account] = await window.ethereum.request({ method: "eth_requestAccounts" });
  await ensureArc();
  return account;
}

const wallet = (account) => createWalletClient({ account, chain, transport: custom(window.ethereum) });

/** Every write first makes sure the wallet is on Arc: users switch networks after connecting. */
async function writer(account) {
  await ensureArc();
  return wallet(account);
}

export async function usdcBalance(account) {
  return Number(await client.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [account] })) / 1e6;
}

async function approveIfNeeded(account, amount, onStep) {
  const allowance = await client.readContract({ address: USDC, abi: erc20Abi, functionName: "allowance", args: [account, VAULT] });
  if (allowance >= amount) return null;
  onStep?.("Approve USDC");
  const hash = await (await writer(account)).writeContract({ address: USDC, abi: erc20Abi, functionName: "approve", args: [VAULT, amount] });
  await client.waitForTransactionReceipt({ hash });
  return hash;
}

/** Buy cover with a signed quote from the pricer. Returns { hash, policyId }. */
export async function buyCover(account, { quote, signature }, onStep) {
  const q = {
    eventId: quote.eventId, outcome: Number(quote.outcome), payout: BigInt(quote.payout), premium: BigInt(quote.premium),
    expiry: BigInt(quote.expiry), eventStart: BigInt(quote.eventStart), buyer: quote.buyer, nonce: BigInt(quote.nonce),
  };
  await approveIfNeeded(account, q.premium, onStep);
  onStep?.("Lock the promise");
  const hash = await (await writer(account)).writeContract({ address: VAULT, abi: vaultAbi, functionName: "buyCover", args: [q, signature] });
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error("Transaction reverted");
  const count = await client.readContract({ address: VAULT, abi: vaultAbi, functionName: "policyCount" });
  return { hash, policyId: Number(count) - 1 };
}

export async function deposit(account, amountUsdc, onStep) {
  const amount = parseUnits(String(amountUsdc), 6);
  await approveIfNeeded(account, amount, onStep);
  onStep?.("Deposit");
  const hash = await (await writer(account)).writeContract({ address: VAULT, abi: vaultAbi, functionName: "deposit", args: [amount, account] });
  await client.waitForTransactionReceipt({ hash });
  return hash;
}

export async function withdrawMax(account, onStep) {
  const max = await client.readContract({ address: VAULT, abi: vaultAbi, functionName: "maxWithdraw", args: [account] });
  if (max === 0n) throw new Error("Nothing withdrawable right now (capital backs open promises, or hedge proceeds are in transit)");
  onStep?.("Withdraw");
  const hash = await (await writer(account)).writeContract({ address: VAULT, abi: vaultAbi, functionName: "withdraw", args: [max, account, account] });
  await client.waitForTransactionReceipt({ hash });
  return hash;
}

export async function claim(account, policyId) {
  const hash = await (await writer(account)).writeContract({ address: VAULT, abi: vaultAbi, functionName: "claim", args: [BigInt(policyId)] });
  await client.waitForTransactionReceipt({ hash });
  return hash;
}

export async function lpPosition(account) {
  const [shares, maxW] = await Promise.all([
    client.readContract({ address: VAULT, abi: vaultAbi, functionName: "balanceOf", args: [account] }),
    client.readContract({ address: VAULT, abi: vaultAbi, functionName: "maxWithdraw", args: [account] }),
  ]);
  const assets = shares > 0n ? await client.readContract({ address: VAULT, abi: vaultAbi, functionName: "convertToAssets", args: [shares] }) : 0n;
  return { assets: Number(assets) / 1e6, withdrawable: Number(maxW) / 1e6 };
}
