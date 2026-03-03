import { createPublicClient, http, type Address } from "viem";
import { base } from "viem/chains";

/** ERC-8004 ReputationRegistry ABI — only the functions we need */
const erc8004ReputationAbi = [
  {
    type: "function",
    name: "getSummary",
    inputs: [
      { name: "agentId", type: "uint256" },
      { name: "clientAddresses", type: "address[]" },
      { name: "tag1", type: "string" },
      { name: "tag2", type: "string" },
    ],
    outputs: [
      { name: "count", type: "uint64" },
      { name: "summaryValue", type: "int128" },
      { name: "summaryValueDecimals", type: "uint8" },
    ],
    stateMutability: "view",
  },
] as const;

/** ERC-8004 IdentityRegistry ABI — check if address owns an agent NFT */
const erc8004IdentityAbi = [
  {
    type: "function",
    name: "balanceOf",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "tokenOfOwnerByIndex",
    inputs: [
      { name: "owner", type: "address" },
      { name: "index", type: "uint256" },
    ],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
] as const;

/** Deployed on Base mainnet (deterministic CREATE2 — same on all chains) */
const ERC8004_IDENTITY_REGISTRY = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432" as Address;
const ERC8004_REPUTATION_REGISTRY = "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63" as Address;

export interface Erc8004Signal {
  registered: boolean;
  agentId: bigint | null;
  feedbackCount: number;
  feedbackValue: number;
  /** Normalized score 0-100 */
  score: number;
}

export async function queryErc8004(
  address: Address
): Promise<Erc8004Signal> {
  const publicClient = createPublicClient({
    chain: base,
    transport: http("https://mainnet.base.org"),
  });

  try {
    // Check if address owns an ERC-8004 identity NFT
    const balance = await publicClient.readContract({
      address: ERC8004_IDENTITY_REGISTRY,
      abi: erc8004IdentityAbi,
      functionName: "balanceOf",
      args: [address],
    });

    if (balance === 0n) {
      return { registered: false, agentId: null, feedbackCount: 0, feedbackValue: 0, score: 0 };
    }

    // Get the agent's token ID
    const agentId = await publicClient.readContract({
      address: ERC8004_IDENTITY_REGISTRY,
      abi: erc8004IdentityAbi,
      functionName: "tokenOfOwnerByIndex",
      args: [address, 0n],
    });

    // Get reputation summary (all tags, all clients)
    const [count, summaryValue, decimals] = await publicClient.readContract({
      address: ERC8004_REPUTATION_REGISTRY,
      abi: erc8004ReputationAbi,
      functionName: "getSummary",
      args: [agentId, [], "", ""],
    });

    const feedbackCount = Number(count);
    const feedbackValue = Number(summaryValue) / 10 ** Number(decimals);

    // Normalize to 0-100 score
    // Registered = 30 base. Feedback count adds up to 40. Positive sentiment adds up to 30.
    let score = 30; // base for being registered
    score += Math.min(feedbackCount * 4, 40); // up to 40 for feedback volume
    if (feedbackCount > 0) {
      const sentiment = feedbackValue / feedbackCount; // average per feedback
      score += Math.min(Math.max(sentiment * 30, 0), 30); // up to 30 for positive sentiment
    }
    score = Math.min(Math.round(score), 100);

    return { registered: true, agentId, feedbackCount, feedbackValue, score };
  } catch {
    // Contract call failed — likely address has no identity
    return { registered: false, agentId: null, feedbackCount: 0, feedbackValue: 0, score: 0 };
  }
}
