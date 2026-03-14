/**
 * Moltbook API integration for agent trust scoring.
 *
 * Moltbook is the largest agent social network (1.5M+ agents).
 * We query public profile data to extract trust signals:
 * - Karma score (community upvotes over time)
 * - Account age
 * - Claimed status (human-verified)
 * - Activity level (posts, comments, followers)
 *
 * Lookup strategy:
 *   1. Try address-based search (agents may link their wallet)
 *   2. Return not-found if no match — never fake data
 */

import { fetchWithRetry } from "../utils/retry.js";

export interface MoltbookSignal {
  found: boolean;
  karma: number;
  accountAgeDays: number;
  isClaimed: boolean;
  followerCount: number;
  postCount: number;
  commentCount: number;
  xVerified: boolean;
  /** Normalized score 0-100 */
  score: number;
}

interface MoltbookAgentProfile {
  id: string;
  name: string;
  karma: number;
  is_claimed: boolean;
  created_at: string;
  follower_count: number;
  stats: {
    posts: number;
    comments: number;
  };
  owner?: {
    x_handle?: string;
    x_verified?: boolean;
    x_follower_count?: number;
  };
  wallets?: Array<{ address: string; chain?: string }>;
}

const MOLTBOOK_BASE_URL = "https://www.moltbook.com/api/v1";

const NOT_FOUND: MoltbookSignal = {
  found: false, karma: 0, accountAgeDays: 0, isClaimed: false,
  followerCount: 0, postCount: 0, commentCount: 0, xVerified: false, score: 0,
};

/**
 * Look up an agent on Moltbook by Ethereum address.
 *
 * Tries multiple lookup strategies:
 *   1. Search by wallet address (agents may link wallets in metadata)
 *   2. Direct name lookup (address as name — some agents use their address)
 *
 * Returns not-found if no match exists.
 */
export async function queryMoltbook(
  addressOrName: string,
  appKey?: string
): Promise<MoltbookSignal> {
  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (appKey) {
      headers["X-Moltbook-App-Key"] = appKey;
    }

    const fetchOpts = { maxAttempts: 2, timeoutMs: 5000, baseDelayMs: 300 };

    // Strategy 1: Search for agents linked to this wallet address
    const searchRes = await fetchWithRetry(
      `${MOLTBOOK_BASE_URL}/agents/search?q=${encodeURIComponent(addressOrName)}&limit=1`,
      { headers },
      fetchOpts
    );

    if (searchRes.ok) {
      const searchData = (await searchRes.json()) as { agents?: MoltbookAgentProfile[] };
      if (searchData.agents && searchData.agents.length > 0) {
        return scoreAgent(searchData.agents[0]);
      }
    }

    // Strategy 2: Direct name lookup (some agents register as their address)
    const profileRes = await fetchWithRetry(
      `${MOLTBOOK_BASE_URL}/agents/profile?name=${encodeURIComponent(addressOrName)}`,
      { headers },
      fetchOpts
    );

    if (profileRes.ok) {
      const data = (await profileRes.json()) as { agent?: MoltbookAgentProfile };
      if (data?.agent) {
        return scoreAgent(data.agent);
      }
    }

    return NOT_FOUND;
  } catch {
    return NOT_FOUND;
  }
}

function scoreAgent(agent: MoltbookAgentProfile): MoltbookSignal {
  const createdAt = new Date(agent.created_at);
  const accountAgeDays = Math.floor(
    (Date.now() - createdAt.getTime()) / (1000 * 60 * 60 * 24)
  );

  // Normalize to 0-100 score
  let score = 0;

  // Karma: up to 35 points (log scale — karma can be very large)
  if (agent.karma > 0) {
    score += Math.min(Math.log10(agent.karma + 1) * 10, 35);
  }

  // Account age: up to 20 points (90+ days = full credit)
  score += Math.min((accountAgeDays / 90) * 20, 20);

  // Claimed (human-verified): 15 points
  if (agent.is_claimed) score += 15;

  // Activity: up to 15 points
  const activity = (agent.stats?.posts ?? 0) + (agent.stats?.comments ?? 0);
  score += Math.min(Math.log10(activity + 1) * 7.5, 15);

  // Followers: up to 10 points
  score += Math.min(Math.log10(agent.follower_count + 1) * 5, 10);

  // X verification bonus: 5 points
  if (agent.owner?.x_verified) score += 5;

  score = Math.min(Math.round(score), 100);

  return {
    found: true,
    karma: agent.karma,
    accountAgeDays,
    isClaimed: agent.is_claimed,
    followerCount: agent.follower_count,
    postCount: agent.stats?.posts ?? 0,
    commentCount: agent.stats?.comments ?? 0,
    xVerified: agent.owner?.x_verified ?? false,
    score,
  };
}
