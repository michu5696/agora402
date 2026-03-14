/**
 * Base chain activity signals via Etherscan V2 API.
 *
 * Extracts trust signals from on-chain activity:
 * - Wallet age (first transaction timestamp)
 * - Transaction count
 * - USDC transfer volume and counterparty count
 */

import type { Address } from "viem";
import { USDC_ADDRESSES } from "@paycrow/core";
import { base } from "viem/chains";
import { fetchWithRetry } from "../utils/retry.js";

export interface BaseChainSignal {
  walletAgeDays: number;
  txCount: number;
  usdcTransferCount: number;
  usdcVolume: number; // in USD
  uniqueCounterparties: number;
  /** Normalized score 0-100 */
  score: number;
}

const ETHERSCAN_V2_BASE = "https://api.etherscan.io/v2/api";
const BASE_CHAIN_ID = 8453;
const USDC_BASE = USDC_ADDRESSES[base.id];

async function etherscanQuery(
  params: Record<string, string>,
  apiKey: string
): Promise<unknown> {
  const url = new URL(ETHERSCAN_V2_BASE);
  url.searchParams.set("chainid", String(BASE_CHAIN_ID));
  url.searchParams.set("apikey", apiKey);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }

  const res = await fetchWithRetry(url.toString(), {}, { maxAttempts: 2, timeoutMs: 10000, baseDelayMs: 500 });
  if (!res.ok) return null;

  const data = (await res.json()) as { status: string; result: unknown };
  if (data.status !== "1") return null;
  return data.result;
}

export async function queryBaseChain(
  address: Address,
  apiKey?: string
): Promise<BaseChainSignal> {
  const key = apiKey ?? process.env.BASESCAN_API_KEY ?? "";
  const empty: BaseChainSignal = {
    walletAgeDays: 0, txCount: 0, usdcTransferCount: 0,
    usdcVolume: 0, uniqueCounterparties: 0, score: 0,
  };

  if (!key) return empty;

  try {
    // Fetch normal transactions (for wallet age + tx count)
    const [txResult, tokenResult] = await Promise.all([
      etherscanQuery({
        module: "account",
        action: "txlist",
        address,
        startblock: "0",
        endblock: "99999999",
        page: "1",
        offset: "100", // first 100 txs is enough for age + count signal
        sort: "asc",
      }, key),
      etherscanQuery({
        module: "account",
        action: "tokentx",
        address,
        contractaddress: USDC_BASE,
        startblock: "0",
        endblock: "99999999",
        page: "1",
        offset: "200",
        sort: "asc",
      }, key),
    ]);

    const txs = Array.isArray(txResult) ? txResult : [];
    const tokenTxs = Array.isArray(tokenResult) ? tokenResult : [];

    // Wallet age from first transaction
    let walletAgeDays = 0;
    if (txs.length > 0 && txs[0].timeStamp) {
      const firstTx = new Date(Number(txs[0].timeStamp) * 1000);
      walletAgeDays = Math.floor((Date.now() - firstTx.getTime()) / (1000 * 60 * 60 * 24));
    }

    // USDC volume and counterparties
    const counterparties = new Set<string>();
    let usdcVolume = 0;
    for (const tx of tokenTxs) {
      const val = Number(tx.value ?? 0) / 1e6; // USDC has 6 decimals
      usdcVolume += val;
      if (tx.from?.toLowerCase() !== address.toLowerCase()) counterparties.add(tx.from);
      if (tx.to?.toLowerCase() !== address.toLowerCase()) counterparties.add(tx.to);
    }

    const txCount = txs.length;
    const usdcTransferCount = tokenTxs.length;
    const uniqueCounterparties = counterparties.size;

    // Normalize to 0-100 score
    let score = 0;

    // Wallet age: up to 25 points (180+ days = full credit)
    score += Math.min((walletAgeDays / 180) * 25, 25);

    // Transaction count: up to 25 points (log scale)
    score += Math.min(Math.log10(txCount + 1) * 12.5, 25);

    // USDC volume: up to 25 points (log scale, $10K+ = full credit)
    if (usdcVolume > 0) {
      score += Math.min(Math.log10(usdcVolume + 1) * 6.25, 25);
    }

    // Counterparty diversity: up to 25 points
    score += Math.min(uniqueCounterparties * 2.5, 25);

    score = Math.min(Math.round(score), 100);

    return { walletAgeDays, txCount, usdcTransferCount, usdcVolume, uniqueCounterparties, score };
  } catch {
    return empty;
  }
}
