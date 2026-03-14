import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { queryMoltbook } from "../../sources/moltbook.js";

function makeAgent(overrides: Record<string, unknown> = {}) {
  return {
    id: "agent-123",
    name: "TestAgent",
    karma: 1000,
    is_claimed: true,
    created_at: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString(),
    follower_count: 100,
    stats: { posts: 50, comments: 100 },
    owner: { x_verified: false },
    wallets: [],
    ...overrides,
  };
}

function mockSearchResponse(agents: unknown[] | null) {
  return {
    ok: true,
    json: async () => ({ agents: agents ?? [] }),
  };
}

function mockProfileResponse(agent: unknown | null) {
  return {
    ok: true,
    json: async () => ({ agent }),
  };
}

describe("queryMoltbook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns not-found when search and profile both return no results", async () => {
    mockFetch
      .mockResolvedValueOnce(mockSearchResponse([]))
      .mockResolvedValueOnce(mockProfileResponse(null));

    const result = await queryMoltbook("0xABC");
    expect(result.found).toBe(false);
    expect(result.score).toBe(0);
  });

  it("returns agent data from search endpoint", async () => {
    mockFetch.mockResolvedValueOnce(mockSearchResponse([makeAgent()]));

    const result = await queryMoltbook("0xABC");
    expect(result.found).toBe(true);
    expect(result.score).toBeGreaterThan(0);
  });

  it("falls back to profile endpoint when search returns empty", async () => {
    mockFetch
      .mockResolvedValueOnce(mockSearchResponse([]))
      .mockResolvedValueOnce(mockProfileResponse(makeAgent()));

    const result = await queryMoltbook("0xABC");
    expect(result.found).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("passes appKey header when provided", async () => {
    mockFetch.mockResolvedValueOnce(mockSearchResponse([makeAgent()]));

    await queryMoltbook("0xABC", "my-key");
    const headers = mockFetch.mock.calls[0][1]?.headers;
    expect(headers["X-Moltbook-App-Key"]).toBe("my-key");
  });

  it("returns not-found on fetch error", async () => {
    mockFetch.mockRejectedValue(new Error("Network error"));
    const result = await queryMoltbook("0xABC");
    expect(result.found).toBe(false);
    expect(result.score).toBe(0);
  });

  it("returns not-found on non-ok response", async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({ ok: false });

    const result = await queryMoltbook("0xABC");
    expect(result.found).toBe(false);
  });

  // ─── scoreAgent scoring math tests ─────────────────────────────

  describe("scoring math", () => {
    it("computes karma score using log10 (up to 35 points)", async () => {
      // karma = 1000 → log10(1001) ≈ 3.0004 → 3.0004 * 10 = 30.004 → min(30, 35)
      mockFetch.mockResolvedValueOnce(
        mockSearchResponse([makeAgent({ karma: 1000, is_claimed: false, follower_count: 0, stats: { posts: 0, comments: 0 }, owner: {} })])
      );
      const result = await queryMoltbook("0xABC");
      const karmaPoints = Math.min(Math.log10(1001) * 10, 35);
      // Account age is ~90 days → 20 points
      expect(result.score).toBeGreaterThanOrEqual(Math.floor(karmaPoints));
    });

    it("caps karma at 35 points for very high karma", async () => {
      // karma = 1_000_000 → log10(1000001) ≈ 6 → 60 → capped at 35
      mockFetch.mockResolvedValueOnce(
        mockSearchResponse([makeAgent({
          karma: 1_000_000,
          is_claimed: false,
          created_at: new Date().toISOString(), // 0 day age
          follower_count: 0,
          stats: { posts: 0, comments: 0 },
          owner: {},
        })])
      );
      const result = await queryMoltbook("0xABC");
      // Only karma contributes (35 max) + 0 for everything else
      expect(result.score).toBe(35);
    });

    it("gives 0 karma points when karma is 0", async () => {
      mockFetch.mockResolvedValueOnce(
        mockSearchResponse([makeAgent({
          karma: 0,
          is_claimed: false,
          created_at: new Date().toISOString(),
          follower_count: 0,
          stats: { posts: 0, comments: 0 },
          owner: {},
        })])
      );
      const result = await queryMoltbook("0xABC");
      expect(result.score).toBe(0);
    });

    it("gives up to 20 points for account age (90+ days = full)", async () => {
      const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
      mockFetch.mockResolvedValueOnce(
        mockSearchResponse([makeAgent({
          karma: 0,
          is_claimed: false,
          created_at: ninetyDaysAgo,
          follower_count: 0,
          stats: { posts: 0, comments: 0 },
          owner: {},
        })])
      );
      const result = await queryMoltbook("0xABC");
      expect(result.score).toBe(20);
    });

    it("gives partial points for account age < 90 days", async () => {
      const fortyFiveDaysAgo = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString();
      mockFetch.mockResolvedValueOnce(
        mockSearchResponse([makeAgent({
          karma: 0,
          is_claimed: false,
          created_at: fortyFiveDaysAgo,
          follower_count: 0,
          stats: { posts: 0, comments: 0 },
          owner: {},
        })])
      );
      const result = await queryMoltbook("0xABC");
      // 45/90 * 20 = 10
      expect(result.score).toBe(10);
    });

    it("gives 15 points for claimed status", async () => {
      mockFetch.mockResolvedValueOnce(
        mockSearchResponse([makeAgent({
          karma: 0,
          is_claimed: true,
          created_at: new Date().toISOString(),
          follower_count: 0,
          stats: { posts: 0, comments: 0 },
          owner: {},
        })])
      );
      const result = await queryMoltbook("0xABC");
      expect(result.score).toBe(15);
    });

    it("gives 5 points for x_verified", async () => {
      mockFetch.mockResolvedValueOnce(
        mockSearchResponse([makeAgent({
          karma: 0,
          is_claimed: false,
          created_at: new Date().toISOString(),
          follower_count: 0,
          stats: { posts: 0, comments: 0 },
          owner: { x_verified: true },
        })])
      );
      const result = await queryMoltbook("0xABC");
      expect(result.score).toBe(5);
    });

    it("computes activity score using log10 (up to 15 points)", async () => {
      // posts=50, comments=100 → activity=150 → log10(151)≈2.178 → 2.178*7.5≈16.34 → capped 15
      mockFetch.mockResolvedValueOnce(
        mockSearchResponse([makeAgent({
          karma: 0,
          is_claimed: false,
          created_at: new Date().toISOString(),
          follower_count: 0,
          stats: { posts: 50, comments: 100 },
          owner: {},
        })])
      );
      const result = await queryMoltbook("0xABC");
      expect(result.score).toBe(15);
    });

    it("computes follower score using log10 (up to 10 points)", async () => {
      // followers=10000 → log10(10001)≈4.0 → 4*5=20 → capped 10
      mockFetch.mockResolvedValueOnce(
        mockSearchResponse([makeAgent({
          karma: 0,
          is_claimed: false,
          created_at: new Date().toISOString(),
          follower_count: 10000,
          stats: { posts: 0, comments: 0 },
          owner: {},
        })])
      );
      const result = await queryMoltbook("0xABC");
      expect(result.score).toBe(10);
    });

    it("computes max score of 100 with all signals maxed", async () => {
      mockFetch.mockResolvedValueOnce(
        mockSearchResponse([makeAgent({
          karma: 1_000_000,
          is_claimed: true,
          created_at: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString(),
          follower_count: 100_000,
          stats: { posts: 10000, comments: 10000 },
          owner: { x_verified: true },
        })])
      );
      const result = await queryMoltbook("0xABC");
      // 35 + 20 + 15 + 15 + 10 + 5 = 100
      expect(result.score).toBe(100);
    });

    it("populates all signal fields correctly", async () => {
      const agent = makeAgent({
        karma: 500,
        is_claimed: true,
        follower_count: 200,
        stats: { posts: 10, comments: 20 },
        owner: { x_verified: true },
      });
      mockFetch.mockResolvedValueOnce(mockSearchResponse([agent]));

      const result = await queryMoltbook("0xABC");
      expect(result.found).toBe(true);
      expect(result.karma).toBe(500);
      expect(result.isClaimed).toBe(true);
      expect(result.followerCount).toBe(200);
      expect(result.postCount).toBe(10);
      expect(result.commentCount).toBe(20);
      expect(result.xVerified).toBe(true);
      expect(result.accountAgeDays).toBeGreaterThanOrEqual(89);
    });
  });
});
