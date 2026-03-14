import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Address } from "viem";

// Mock source modules before importing engine
vi.mock("../sources/erc8004.js", () => ({ queryErc8004: vi.fn() }));
vi.mock("../sources/moltbook.js", () => ({ queryMoltbook: vi.fn() }));
vi.mock("../sources/base-chain.js", () => ({ queryBaseChain: vi.fn() }));

const mockReadContract = vi.fn();

vi.mock("viem", async () => {
  const actual = await vi.importActual("viem");
  return {
    ...actual,
    createPublicClient: vi.fn(() => ({
      readContract: mockReadContract,
    })),
  };
});

import { computeTrustScore } from "../engine.js";
import { queryErc8004 } from "../sources/erc8004.js";
import { queryMoltbook } from "../sources/moltbook.js";
import { queryBaseChain } from "../sources/base-chain.js";

const mockedErc8004 = vi.mocked(queryErc8004);
const mockedMoltbook = vi.mocked(queryMoltbook);
const mockedBaseChain = vi.mocked(queryBaseChain);

const ADDR = "0x1234567890abcdef1234567890abcdef12345678" as Address;

// Helper: set up mockReadContract for queryPayCrow's two readContract calls
function setupPayCrow(opts: {
  rawScore?: bigint;
  completed?: bigint;
  disputed?: bigint;
  refunded?: bigint;
  asProvider?: bigint;
  asClient?: bigint;
  volume?: bigint;
  firstSeen?: bigint;
  lastSeen?: bigint;
}) {
  const {
    rawScore = 80n,
    completed = 10n,
    disputed = 0n,
    refunded = 0n,
    asProvider = 5n,
    asClient = 5n,
    volume = 5000_000000n,
    firstSeen = BigInt(Math.floor(Date.now() / 1000) - 86400 * 90),
    lastSeen = BigInt(Math.floor(Date.now() / 1000)),
  } = opts;

  mockReadContract
    .mockResolvedValueOnce(rawScore)
    .mockResolvedValueOnce([
      completed, disputed, refunded, asProvider, asClient, volume, firstSeen, lastSeen,
    ]);
}

// Helper: set up PayCrow with NO interactions (returns null from queryPayCrow)
function setupPayCrowEmpty() {
  mockReadContract
    .mockResolvedValueOnce(50n)
    .mockResolvedValueOnce([0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n]);
}

// Helper: set up PayCrow to fail
function setupPayCrowFail() {
  mockReadContract.mockRejectedValue(new Error("RPC timeout"));
}

function erc8004Registered(score: number, feedbackCount = 5, feedbackValue = 4.0) {
  return { registered: true, agentId: 42n, feedbackCount, feedbackValue, score };
}

function erc8004NotRegistered() {
  return { registered: false, agentId: null, feedbackCount: 0, feedbackValue: 0, score: 0 };
}

function moltbookFound(score: number) {
  return {
    found: true, karma: 1000, accountAgeDays: 120, isClaimed: true,
    followerCount: 50, postCount: 20, commentCount: 30, xVerified: false, score,
  };
}

function moltbookNotFound() {
  return {
    found: false, karma: 0, accountAgeDays: 0, isClaimed: false,
    followerCount: 0, postCount: 0, commentCount: 0, xVerified: false, score: 0,
  };
}

function baseChainActive(score: number, txCount = 50) {
  return {
    walletAgeDays: 200, txCount, usdcTransferCount: 10,
    usdcVolume: 5000, uniqueCounterparties: 8, score,
  };
}

function baseChainEmpty() {
  return {
    walletAgeDays: 0, txCount: 0, usdcTransferCount: 0,
    usdcVolume: 0, uniqueCounterparties: 0, score: 0,
  };
}

describe("computeTrustScore", () => {
  beforeEach(() => {
    mockReadContract.mockReset();
    mockedErc8004.mockReset();
    mockedMoltbook.mockReset();
    mockedBaseChain.mockReset();
  });

  // ─── 1. No data from any source ───────────────────────────────────
  it("returns null score and insufficient_data when no source has data", async () => {
    setupPayCrowEmpty();
    mockedErc8004.mockResolvedValue(erc8004NotRegistered());
    mockedMoltbook.mockResolvedValue(moltbookNotFound());
    mockedBaseChain.mockResolvedValue(baseChainEmpty());

    const result = await computeTrustScore(ADDR);
    expect(result.score).toBeNull();
    expect(result.confidence).toBe("none");
    expect(result.confidencePercent).toBe(0);
    expect(result.recommendation).toBe("insufficient_data");
    expect(result.sourcesUsed).toEqual([]);
  });

  // ─── 2. Single source: PayCrow only ──────────────────────────────
  it("uses only PayCrow when it is the sole source with data", async () => {
    setupPayCrow({ rawScore: 80n, completed: 10n });
    mockedErc8004.mockResolvedValue(erc8004NotRegistered());
    mockedMoltbook.mockResolvedValue(moltbookNotFound());
    mockedBaseChain.mockResolvedValue(baseChainEmpty());

    const result = await computeTrustScore(ADDR);
    expect(result.score).toBe(80); // 80 * 0.4 / 0.4 = 80
    expect(result.sourcesUsed).toEqual(["paycrow"]);
    // 0.4 / 1.0 = 40% → medium confidence
    expect(result.confidencePercent).toBe(40);
    expect(result.confidence).toBe("medium");
  });

  // ─── 3. Single source: ERC-8004 only ─────────────────────────────
  it("uses only ERC-8004 when it is the sole source with data", async () => {
    setupPayCrowEmpty();
    mockedErc8004.mockResolvedValue(erc8004Registered(70));
    mockedMoltbook.mockResolvedValue(moltbookNotFound());
    mockedBaseChain.mockResolvedValue(baseChainEmpty());

    const result = await computeTrustScore(ADDR);
    expect(result.score).toBe(70);
    expect(result.sourcesUsed).toEqual(["erc8004"]);
    // 0.25 / 1.0 = 25% → low confidence
    expect(result.confidencePercent).toBe(25);
    expect(result.confidence).toBe("low");
  });

  // ─── 4. Single source: Moltbook only ────────────────────────────
  it("uses only Moltbook when it is the sole source with data", async () => {
    setupPayCrowEmpty();
    mockedErc8004.mockResolvedValue(erc8004NotRegistered());
    mockedMoltbook.mockResolvedValue(moltbookFound(65));
    mockedBaseChain.mockResolvedValue(baseChainEmpty());

    const result = await computeTrustScore(ADDR);
    expect(result.score).toBe(65);
    expect(result.sourcesUsed).toEqual(["moltbook"]);
    expect(result.confidencePercent).toBe(15);
    expect(result.confidence).toBe("low");
  });

  // ─── 5. Single source: Base chain only ──────────────────────────
  it("uses only base chain when it is the sole source with data", async () => {
    setupPayCrowEmpty();
    mockedErc8004.mockResolvedValue(erc8004NotRegistered());
    mockedMoltbook.mockResolvedValue(moltbookNotFound());
    mockedBaseChain.mockResolvedValue(baseChainActive(60));

    const result = await computeTrustScore(ADDR);
    expect(result.score).toBe(60);
    expect(result.sourcesUsed).toEqual(["base-chain"]);
    expect(result.confidencePercent).toBe(20);
    expect(result.confidence).toBe("low");
  });

  // ─── 6. Two sources: PayCrow + ERC-8004 ─────────────────────────
  it("computes weighted average of two sources", async () => {
    setupPayCrow({ rawScore: 80n, completed: 10n });
    mockedErc8004.mockResolvedValue(erc8004Registered(60));
    mockedMoltbook.mockResolvedValue(moltbookNotFound());
    mockedBaseChain.mockResolvedValue(baseChainEmpty());

    const result = await computeTrustScore(ADDR);
    // (80*0.4 + 60*0.25) / (0.4+0.25) = (32+15)/0.65 = 72.307... → 72
    expect(result.score).toBe(72);
    expect(result.sourcesUsed).toEqual(["paycrow", "erc8004"]);
    expect(result.confidencePercent).toBe(65);
    expect(result.confidence).toBe("high");
  });

  // ─── 7. Three sources ───────────────────────────────────────────
  it("computes weighted average of three sources", async () => {
    setupPayCrow({ rawScore: 90n, completed: 20n });
    mockedErc8004.mockResolvedValue(erc8004Registered(70));
    mockedMoltbook.mockResolvedValue(moltbookFound(50));
    mockedBaseChain.mockResolvedValue(baseChainEmpty());

    const result = await computeTrustScore(ADDR);
    // (90*0.4 + 70*0.25 + 50*0.15) / (0.4+0.25+0.15) = (36+17.5+7.5)/0.8 = 76.25 → 76
    expect(result.score).toBe(76);
    expect(result.sourcesUsed).toEqual(["paycrow", "erc8004", "moltbook"]);
    expect(result.confidencePercent).toBe(80);
    expect(result.confidence).toBe("high");
  });

  // ─── 8. All four sources ────────────────────────────────────────
  it("computes weighted average of all four sources with high confidence", async () => {
    setupPayCrow({ rawScore: 90n, completed: 20n });
    mockedErc8004.mockResolvedValue(erc8004Registered(70));
    mockedMoltbook.mockResolvedValue(moltbookFound(50));
    mockedBaseChain.mockResolvedValue(baseChainActive(60));

    const result = await computeTrustScore(ADDR);
    // (90*0.4 + 70*0.25 + 50*0.15 + 60*0.2) / 1.0 = 36+17.5+7.5+12 = 73
    expect(result.score).toBe(73);
    expect(result.sourcesUsed).toEqual(["paycrow", "erc8004", "moltbook", "base-chain"]);
    expect(result.confidencePercent).toBe(100);
    expect(result.confidence).toBe("high");
  });

  // ─── 9. Dispute rate > 20% → caution ──────────────────────────
  it("recommends caution when dispute rate exceeds 20%", async () => {
    // 3 completed, 2 disputed → disputeRate = 2/5 = 0.4
    setupPayCrow({ rawScore: 70n, completed: 3n, disputed: 2n, refunded: 0n });
    mockedErc8004.mockResolvedValue(erc8004Registered(80));
    mockedMoltbook.mockResolvedValue(moltbookFound(70));
    mockedBaseChain.mockResolvedValue(baseChainActive(80));

    const result = await computeTrustScore(ADDR);
    expect(result.recommendation).toBe("caution");
    expect(result.sources.paycrow!.disputeRate).toBe(0.4);
  });

  // ─── 10. Low confidence caps recommendation at moderate_trust ──
  it("caps recommendation at moderate_trust when confidence is low", async () => {
    setupPayCrowEmpty();
    // Only ERC-8004 with a high score (25% weight → low confidence)
    mockedErc8004.mockResolvedValue(erc8004Registered(95));
    mockedMoltbook.mockResolvedValue(moltbookNotFound());
    mockedBaseChain.mockResolvedValue(baseChainEmpty());

    const result = await computeTrustScore(ADDR);
    expect(result.score).toBe(95);
    expect(result.confidence).toBe("low");
    // Score >= 75 but capped to moderate_trust since confidence is low
    expect(result.recommendation).toBe("moderate_trust");
  });

  // ─── 11. Low confidence + score < 45 → low_trust ─────────────
  it("returns low_trust when confidence is low and score < 45", async () => {
    setupPayCrowEmpty();
    mockedErc8004.mockResolvedValue(erc8004Registered(30));
    mockedMoltbook.mockResolvedValue(moltbookNotFound());
    mockedBaseChain.mockResolvedValue(baseChainEmpty());

    const result = await computeTrustScore(ADDR);
    expect(result.score).toBe(30);
    expect(result.confidence).toBe("low");
    expect(result.recommendation).toBe("low_trust");
  });

  // ─── 12. Source failure (Promise.allSettled rejection) ──────────
  it("skips sources that reject (Promise.allSettled)", async () => {
    setupPayCrowFail();
    mockedErc8004.mockRejectedValue(new Error("Network error"));
    mockedMoltbook.mockResolvedValue(moltbookFound(65));
    mockedBaseChain.mockResolvedValue(baseChainActive(60));

    const result = await computeTrustScore(ADDR);
    // Only moltbook (65) and base-chain (60) available
    // (65*0.15 + 60*0.2) / (0.15+0.2) = (9.75+12)/0.35 = 62.14 → 62
    expect(result.score).toBe(62);
    expect(result.sourcesUsed).toEqual(["moltbook", "base-chain"]);
    expect(result.confidencePercent).toBe(35);
    expect(result.confidence).toBe("medium");
  });

  // ─── 13. Score threshold: >= 75 → high_trust ──────────────────
  it("recommends high_trust for score >= 75 with medium+ confidence", async () => {
    setupPayCrow({ rawScore: 95n, completed: 20n });
    mockedErc8004.mockResolvedValue(erc8004Registered(90));
    mockedMoltbook.mockResolvedValue(moltbookNotFound());
    mockedBaseChain.mockResolvedValue(baseChainEmpty());

    const result = await computeTrustScore(ADDR);
    // (95*0.4 + 90*0.25) / 0.65 = (38+22.5)/0.65 = 93.07... → 93
    expect(result.score).toBe(93);
    expect(result.confidence).toBe("high");
    expect(result.recommendation).toBe("high_trust");
  });

  // ─── 14. Score threshold: 45-74 → moderate_trust ──────────────
  it("recommends moderate_trust for score 45-74 with medium+ confidence", async () => {
    setupPayCrow({ rawScore: 50n, completed: 10n });
    mockedErc8004.mockResolvedValue(erc8004Registered(55));
    mockedMoltbook.mockResolvedValue(moltbookNotFound());
    mockedBaseChain.mockResolvedValue(baseChainEmpty());

    const result = await computeTrustScore(ADDR);
    // (50*0.4 + 55*0.25) / 0.65 = (20+13.75)/0.65 = 51.92 → 52
    expect(result.score).toBe(52);
    expect(result.recommendation).toBe("moderate_trust");
  });

  // ─── 15. Score threshold: 20-44 → low_trust ──────────────────
  it("recommends low_trust for score 20-44 with medium+ confidence", async () => {
    setupPayCrow({ rawScore: 30n, completed: 5n });
    mockedErc8004.mockResolvedValue(erc8004Registered(20));
    mockedMoltbook.mockResolvedValue(moltbookNotFound());
    mockedBaseChain.mockResolvedValue(baseChainEmpty());

    const result = await computeTrustScore(ADDR);
    // (30*0.4 + 20*0.25) / 0.65 = (12+5)/0.65 = 26.15 → 26
    expect(result.score).toBe(26);
    expect(result.recommendation).toBe("low_trust");
  });

  // ─── 16. Score threshold: < 20 → caution ─────────────────────
  it("recommends caution for score < 20 with medium+ confidence", async () => {
    setupPayCrow({ rawScore: 10n, completed: 5n });
    mockedErc8004.mockResolvedValue(erc8004Registered(5));
    mockedMoltbook.mockResolvedValue(moltbookNotFound());
    mockedBaseChain.mockResolvedValue(baseChainEmpty());

    const result = await computeTrustScore(ADDR);
    // (10*0.4 + 5*0.25) / 0.65 = (4+1.25)/0.65 = 8.07 → 8
    expect(result.score).toBe(8);
    expect(result.recommendation).toBe("caution");
  });

  // ─── 17. PayCrow dispute penalty applied correctly ────────────
  it("applies dispute penalty to PayCrow raw score", async () => {
    // 8 completed, 2 disputed → 20% dispute rate
    // New penalty formula: round(0.2^2 * 70 + 0.2 * 30) = round(2.8 + 6) = 9
    // rawScore = 80, penalized = 80 - 9 = 71
    setupPayCrow({ rawScore: 80n, completed: 8n, disputed: 2n, refunded: 0n });
    mockedErc8004.mockResolvedValue(erc8004NotRegistered());
    mockedMoltbook.mockResolvedValue(moltbookNotFound());
    mockedBaseChain.mockResolvedValue(baseChainEmpty());

    const result = await computeTrustScore(ADDR);
    expect(result.sources.paycrow!.score).toBe(71);
    expect(result.sources.paycrow!.disputeRate).toBe(0.2);
    expect(result.score).toBe(71);
  });

  // ─── 18. PayCrow returns null for zero interactions ───────────
  it("treats PayCrow as no data when address has zero interactions", async () => {
    setupPayCrowEmpty();
    mockedErc8004.mockResolvedValue(erc8004NotRegistered());
    mockedMoltbook.mockResolvedValue(moltbookNotFound());
    mockedBaseChain.mockResolvedValue(baseChainEmpty());

    const result = await computeTrustScore(ADDR);
    expect(result.sources.paycrow).toBeNull();
    expect(result.sourcesUsed).not.toContain("paycrow");
  });

  // ─── 19. ERC-8004 not registered → skipped ───────────────────
  it("skips ERC-8004 when not registered", async () => {
    setupPayCrow({ rawScore: 80n, completed: 10n });
    mockedErc8004.mockResolvedValue(erc8004NotRegistered());
    mockedMoltbook.mockResolvedValue(moltbookNotFound());
    mockedBaseChain.mockResolvedValue(baseChainEmpty());

    const result = await computeTrustScore(ADDR);
    expect(result.sourcesUsed).not.toContain("erc8004");
  });

  // ─── 20. Moltbook not found → skipped ────────────────────────
  it("skips Moltbook when agent not found", async () => {
    setupPayCrow({ rawScore: 80n, completed: 10n });
    mockedErc8004.mockResolvedValue(erc8004NotRegistered());
    mockedMoltbook.mockResolvedValue(moltbookNotFound());
    mockedBaseChain.mockResolvedValue(baseChainEmpty());

    const result = await computeTrustScore(ADDR);
    expect(result.sourcesUsed).not.toContain("moltbook");
  });

  // ─── 21. Base chain 0 txCount → skipped ──────────────────────
  it("skips base chain when txCount is 0", async () => {
    setupPayCrow({ rawScore: 80n, completed: 10n });
    mockedErc8004.mockResolvedValue(erc8004NotRegistered());
    mockedMoltbook.mockResolvedValue(moltbookNotFound());
    mockedBaseChain.mockResolvedValue(baseChainEmpty());

    const result = await computeTrustScore(ADDR);
    expect(result.sourcesUsed).not.toContain("base-chain");
  });

  // ─── 22. Confidence thresholds: medium at 40% ────────────────
  it("assigns medium confidence at 35-59%", async () => {
    // PayCrow only: 40% → medium
    setupPayCrow({ rawScore: 60n, completed: 5n });
    mockedErc8004.mockResolvedValue(erc8004NotRegistered());
    mockedMoltbook.mockResolvedValue(moltbookNotFound());
    mockedBaseChain.mockResolvedValue(baseChainEmpty());

    const result = await computeTrustScore(ADDR);
    expect(result.confidencePercent).toBe(40);
    expect(result.confidence).toBe("medium");
  });

  // ─── 23. Dispute rate exactly 20% → NOT caution ──────────────
  it("flags caution when dispute rate is exactly 20% (threshold is 15%)", async () => {
    // 8 completed, 2 disputed → 2/10 = 0.2, which IS > 0.15 threshold
    setupPayCrow({ rawScore: 80n, completed: 8n, disputed: 2n, refunded: 0n });
    mockedErc8004.mockResolvedValue(erc8004Registered(80));
    mockedMoltbook.mockResolvedValue(moltbookFound(70));
    mockedBaseChain.mockResolvedValue(baseChainActive(70));

    const result = await computeTrustScore(ADDR);
    expect(result.sources.paycrow!.disputeRate).toBe(0.2);
    expect(result.recommendation).toBe("caution");
  });

  // ─── 24. Dispute rate just above 20% → caution ──────────────
  it("flags caution when dispute rate is just above 20%", async () => {
    // 3 completed, 1 disputed → 1/4 = 0.25
    setupPayCrow({ rawScore: 80n, completed: 3n, disputed: 1n, refunded: 0n });
    mockedErc8004.mockResolvedValue(erc8004Registered(80));
    mockedMoltbook.mockResolvedValue(moltbookFound(70));
    mockedBaseChain.mockResolvedValue(baseChainActive(70));

    const result = await computeTrustScore(ADDR);
    expect(result.sources.paycrow!.disputeRate).toBe(0.25);
    expect(result.recommendation).toBe("caution");
  });

  // ─── 25. All sources fail → insufficient_data ────────────────
  it("returns insufficient_data when all sources fail", async () => {
    setupPayCrowFail();
    mockedErc8004.mockRejectedValue(new Error("Timeout"));
    mockedMoltbook.mockRejectedValue(new Error("Timeout"));
    mockedBaseChain.mockRejectedValue(new Error("Timeout"));

    const result = await computeTrustScore(ADDR);
    expect(result.score).toBeNull();
    expect(result.confidence).toBe("none");
    expect(result.recommendation).toBe("insufficient_data");
    expect(result.sourcesUsed).toEqual([]);
  });

  // ─── 26. PayCrow dispute penalty cannot make score negative ──
  it("clamps PayCrow score to 0 when dispute penalty is very high", async () => {
    // All disputed: disputeRate = 1.0, penalty = 50, rawScore = 30 → max(0, 30-50) = 0
    setupPayCrow({ rawScore: 30n, completed: 0n, disputed: 10n, refunded: 0n });
    mockedErc8004.mockResolvedValue(erc8004NotRegistered());
    mockedMoltbook.mockResolvedValue(moltbookNotFound());
    mockedBaseChain.mockResolvedValue(baseChainEmpty());

    const result = await computeTrustScore(ADDR);
    expect(result.sources.paycrow!.score).toBe(0);
    expect(result.score).toBe(0);
  });

  // ─── 27. Output shape ────────────────────────────────────────
  it("includes all required fields in the output", async () => {
    setupPayCrow({ rawScore: 80n, completed: 10n });
    mockedErc8004.mockResolvedValue(erc8004Registered(70));
    mockedMoltbook.mockResolvedValue(moltbookFound(50));
    mockedBaseChain.mockResolvedValue(baseChainActive(60));

    const result = await computeTrustScore(ADDR);
    expect(result).toHaveProperty("address", ADDR);
    expect(result).toHaveProperty("score");
    expect(result).toHaveProperty("confidence");
    expect(result).toHaveProperty("confidencePercent");
    expect(result).toHaveProperty("recommendation");
    expect(result).toHaveProperty("sources");
    expect(result).toHaveProperty("sourcesUsed");
    expect(result).toHaveProperty("timestamp");
    expect(result).toHaveProperty("chain");
    expect(result.sources).toHaveProperty("paycrow");
    expect(result.sources).toHaveProperty("erc8004");
    expect(result.sources).toHaveProperty("moltbook");
    expect(result.sources).toHaveProperty("baseChain");
    expect(result.chain).toBe("base");
  });

  // ─── 28. PayCrow volume formatting ───────────────────────────
  it("formats PayCrow volume as dollar string", async () => {
    setupPayCrow({
      rawScore: 80n,
      completed: 10n,
      volume: 12345_678900n, // 12345.6789 USDC
    });
    mockedErc8004.mockResolvedValue(erc8004NotRegistered());
    mockedMoltbook.mockResolvedValue(moltbookNotFound());
    mockedBaseChain.mockResolvedValue(baseChainEmpty());

    const result = await computeTrustScore(ADDR);
    expect(result.sources.paycrow!.totalVolume).toBe("$12345.68");
  });

  // ─── 29. PayCrow firstSeen/lastSeen timestamps ──────────────
  it("formats PayCrow timestamps correctly", async () => {
    const ts = BigInt(Math.floor(new Date("2024-01-15T00:00:00Z").getTime() / 1000));
    setupPayCrow({
      rawScore: 80n,
      completed: 10n,
      firstSeen: ts,
      lastSeen: ts,
    });
    mockedErc8004.mockResolvedValue(erc8004NotRegistered());
    mockedMoltbook.mockResolvedValue(moltbookNotFound());
    mockedBaseChain.mockResolvedValue(baseChainEmpty());

    const result = await computeTrustScore(ADDR);
    expect(result.sources.paycrow!.firstSeen).toContain("2024-01-15");
    expect(result.sources.paycrow!.lastSeen).toContain("2024-01-15");
  });

  // ─── 30. PayCrow firstSeen/lastSeen null for 0 timestamps ───
  it("returns null timestamps when firstSeen/lastSeen is 0", async () => {
    setupPayCrow({
      rawScore: 80n,
      completed: 10n,
      firstSeen: 0n,
      lastSeen: 0n,
    });
    mockedErc8004.mockResolvedValue(erc8004NotRegistered());
    mockedMoltbook.mockResolvedValue(moltbookNotFound());
    mockedBaseChain.mockResolvedValue(baseChainEmpty());

    const result = await computeTrustScore(ADDR);
    expect(result.sources.paycrow!.firstSeen).toBeNull();
    expect(result.sources.paycrow!.lastSeen).toBeNull();
  });

  // ─── 31. PayCrow with only refunded transactions ─────────────
  it("counts refunded-only address as having data", async () => {
    setupPayCrow({ rawScore: 40n, completed: 0n, disputed: 0n, refunded: 3n });
    mockedErc8004.mockResolvedValue(erc8004NotRegistered());
    mockedMoltbook.mockResolvedValue(moltbookNotFound());
    mockedBaseChain.mockResolvedValue(baseChainEmpty());

    const result = await computeTrustScore(ADDR);
    expect(result.sourcesUsed).toContain("paycrow");
    // rawScore=40, refundRate=3/3=1.0 > 0.3, refund penalty=round((1.0-0.3)*20)=14
    // score = 40-14 = 26
    expect(result.sources.paycrow!.score).toBe(26);
    expect(result.sources.paycrow!.disputeRate).toBe(0);
  });

  // ─── 32. Config: chain option ────────────────────────────────
  it("accepts base-sepolia chain config", async () => {
    setupPayCrowEmpty();
    mockedErc8004.mockResolvedValue(erc8004NotRegistered());
    mockedMoltbook.mockResolvedValue(moltbookNotFound());
    mockedBaseChain.mockResolvedValue(baseChainEmpty());

    const result = await computeTrustScore(ADDR, { chain: "base-sepolia" });
    expect(result.chain).toBe("base-sepolia");
  });

  // ─── 33. Weighted math precision: verify rounding ────────────
  it("rounds the weighted average to nearest integer", async () => {
    // PayCrow: 77, ERC-8004: 63
    // (77*0.4 + 63*0.25) / 0.65 = (30.8+15.75)/0.65 = 71.615... → 72
    setupPayCrow({ rawScore: 77n, completed: 10n });
    mockedErc8004.mockResolvedValue(erc8004Registered(63));
    mockedMoltbook.mockResolvedValue(moltbookNotFound());
    mockedBaseChain.mockResolvedValue(baseChainEmpty());

    const result = await computeTrustScore(ADDR);
    expect(result.score).toBe(72);
  });

  // ─── 34. PayCrow only disputes, no completed ─────────────────
  it("handles address with only disputed transactions", async () => {
    // 5 disputed, 0 completed, 0 refunded → disputeRate = 1.0
    // rawScore = 50, penalty = round(1.0*50) = 50, final = max(0, 50-50) = 0
    setupPayCrow({ rawScore: 50n, completed: 0n, disputed: 5n, refunded: 0n });
    mockedErc8004.mockResolvedValue(erc8004NotRegistered());
    mockedMoltbook.mockResolvedValue(moltbookNotFound());
    mockedBaseChain.mockResolvedValue(baseChainEmpty());

    const result = await computeTrustScore(ADDR);
    expect(result.sources.paycrow!.disputeRate).toBe(1.0);
    expect(result.sources.paycrow!.score).toBe(0);
    expect(result.recommendation).toBe("caution");
  });

  // ─── 35. Mixed: high score but dispute forces caution ────────
  it("forces caution even with high composite score if dispute rate > 20%", async () => {
    // disputeRate > 0.2 triggers caution regardless of final score
    setupPayCrow({ rawScore: 95n, completed: 6n, disputed: 2n, refunded: 0n });
    mockedErc8004.mockResolvedValue(erc8004Registered(95));
    mockedMoltbook.mockResolvedValue(moltbookFound(90));
    mockedBaseChain.mockResolvedValue(baseChainActive(90));

    const result = await computeTrustScore(ADDR);
    // disputeRate = 2/8 = 0.25 > 0.2
    expect(result.sources.paycrow!.disputeRate).toBe(0.25);
    expect(result.recommendation).toBe("caution");
    // But the score itself is still computed
    expect(result.score).toBeGreaterThan(75);
  });
});
