import { base, baseSepolia } from "viem/chains";
import type { Chain, Hash, Address } from "viem";
import { EscrowClient } from "@paycrow/escrow-client";
import { ESCROW_ADDRESSES, REPUTATION_ADDRESSES } from "@paycrow/core";

/**
 * Resolve which chain to use based on environment.
 *
 * CHAIN env var:
 *   "base"          → Base mainnet
 *   "base-sepolia"  → Base Sepolia testnet (default)
 */
export function getChain(): Chain {
  const chainEnv = process.env.CHAIN?.toLowerCase();
  if (chainEnv === "base" || chainEnv === "base-mainnet") return base;
  return baseSepolia;
}

export function getRpcUrl(): string {
  const chain = getChain();
  if (chain.id === base.id) {
    return process.env.BASE_RPC_URL ?? "https://mainnet.base.org";
  }
  return process.env.BASE_SEPOLIA_RPC_URL ?? "https://sepolia.base.org";
}

export function getChainName(): string {
  return getChain().id === base.id ? "base" : "base-sepolia";
}

export function getEscrowAddress(): Address {
  const env = process.env.ESCROW_CONTRACT_ADDRESS;
  if (env) return env as Address;
  const chain = getChain();
  const addr = ESCROW_ADDRESSES[chain.id];
  if (!addr) throw new Error(`No escrow contract deployed on ${chain.name}`);
  return addr;
}

export function getReputationAddress(): Address {
  const env = process.env.REPUTATION_CONTRACT_ADDRESS;
  if (env) return env as Address;
  const chain = getChain();
  const addr = REPUTATION_ADDRESSES[chain.id];
  if (!addr)
    throw new Error(`No reputation contract deployed on ${chain.name}`);
  return addr;
}

export function getEscrowClient(): EscrowClient {
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) {
    throw new Error(
      "PRIVATE_KEY must be set. Run `npx paycrow init` to generate a wallet."
    );
  }

  return new EscrowClient({
    privateKey: privateKey as Hash,
    escrowAddress: getEscrowAddress(),
    rpcUrl: getRpcUrl(),
    chain: getChain(),
  });
}
