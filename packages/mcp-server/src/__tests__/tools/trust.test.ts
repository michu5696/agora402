import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ───────────────────────────────────────────────────────────

vi.mock("../../config.js", () => ({
  getEscrowClient: vi.fn(),
  getChain: vi.fn(() => ({ id: 84532, name: "Base Sepolia" })),
  getRpcUrl: vi.fn(() => "https://sepolia.base.org"),
  getChainName: vi.fn(() => "base-sepolia"),
  getReputationAddress: vi.fn(
    () => "0x2A216a829574e88dD632e7C95660d43bCE627CDf",
  ),
}));

vi.mock("@paycrow/trust", () => ({
  computeTrustScore: vi.fn(),
}));

// Shared mock for the publicClient created at module top-level in trust.ts.
// We use a container object so the vi.mock factory (which runs before
// variable declarations) can reference it via hoisted closure.
const _mocks = vi.hoisted(() => {
  const readContract = vi.fn();
  return { readContract };
});

vi.mock("viem", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    createPublicClient: vi.fn(() => ({
      readContract: _mocks.readContract,
    })),
  };
});

import { computeTrustScore } from "@paycrow/trust";
import { registerTrustTools } from "../../tools/trust.js";

// ── Capture tool handlers ───────────────────────────────────────────

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
}>;

const toolHandlers: Record<string, ToolHandler> = {};
const mockServer = {
  tool: vi.fn(
    (name: string, _desc: string, _schema: unknown, handler: ToolHandler) => {
      toolHandlers[name] = handler;
    },
  ),
};

function parseResponse(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0].text);
}

const TEST_ADDRESS = "0x1234567890abcdef1234567890abcdef12345678";

beforeEach(() => {
  vi.clearAllMocks();
  Object.keys(toolHandlers).forEach((k) => delete toolHandlers[k]);
  registerTrustTools(mockServer as any);
});

// ── trust_gate ──────────────────────────────────────────────────────

describe("trust_gate", () => {
  it("high trust agent -> proceed with 15min timelock", async () => {
    vi.mocked(computeTrustScore).mockResolvedValue({
      address: TEST_ADDRESS,
      score: 90,
      confidence: "high",
      confidencePercent: 80,
      recommendation: "high_trust",
      sources: { paycrow: null, erc8004: null, moltbook: null, baseChain: null },
      sourcesUsed: ["paycrow", "base-chain"],
      timestamp: new Date().toISOString(),
      chain: "base-sepolia",
    });

    const result = await toolHandlers["trust_gate"]({
      address: TEST_ADDRESS,
    });
    const data = parseResponse(result);

    expect(data.decision).toBe("proceed");
    expect(data.escrowParams.recommendedTimelockMinutes).toBe(15);
    expect(data.escrowParams.maxRecommendedUsdc).toBe(100);
  });

  it("moderate trust agent -> proceed_with_caution with 60min", async () => {
    vi.mocked(computeTrustScore).mockResolvedValue({
      address: TEST_ADDRESS,
      score: 60,
      confidence: "medium",
      confidencePercent: 50,
      recommendation: "moderate_trust",
      sources: { paycrow: null, erc8004: null, moltbook: null, baseChain: null },
      sourcesUsed: ["base-chain"],
      timestamp: new Date().toISOString(),
      chain: "base-sepolia",
    });

    const result = await toolHandlers["trust_gate"]({
      address: TEST_ADDRESS,
    });
    const data = parseResponse(result);

    expect(data.decision).toBe("proceed_with_caution");
    expect(data.escrowParams.recommendedTimelockMinutes).toBe(60);
    expect(data.escrowParams.maxRecommendedUsdc).toBe(25);
  });

  it("low trust agent -> proceed_with_caution with 240min", async () => {
    vi.mocked(computeTrustScore).mockResolvedValue({
      address: TEST_ADDRESS,
      score: 30,
      confidence: "medium",
      confidencePercent: 40,
      recommendation: "low_trust",
      sources: { paycrow: null, erc8004: null, moltbook: null, baseChain: null },
      sourcesUsed: ["paycrow"],
      timestamp: new Date().toISOString(),
      chain: "base-sepolia",
    });

    const result = await toolHandlers["trust_gate"]({
      address: TEST_ADDRESS,
    });
    const data = parseResponse(result);

    expect(data.decision).toBe("proceed_with_caution");
    expect(data.escrowParams.recommendedTimelockMinutes).toBe(240);
    expect(data.escrowParams.maxRecommendedUsdc).toBe(5);
  });

  it("caution recommendation -> do_not_proceed", async () => {
    vi.mocked(computeTrustScore).mockResolvedValue({
      address: TEST_ADDRESS,
      score: 15,
      confidence: "high",
      confidencePercent: 70,
      recommendation: "caution",
      sources: { paycrow: null, erc8004: null, moltbook: null, baseChain: null },
      sourcesUsed: ["paycrow", "base-chain"],
      timestamp: new Date().toISOString(),
      chain: "base-sepolia",
    });

    const result = await toolHandlers["trust_gate"]({
      address: TEST_ADDRESS,
    });
    const data = parseResponse(result);

    expect(data.decision).toBe("do_not_proceed");
    expect(data.reasoning).toContain("dispute rate");
  });

  it("insufficient_data -> do_not_proceed", async () => {
    vi.mocked(computeTrustScore).mockResolvedValue({
      address: TEST_ADDRESS,
      score: null,
      confidence: "none",
      confidencePercent: 0,
      recommendation: "insufficient_data",
      sources: { paycrow: null, erc8004: null, moltbook: null, baseChain: null },
      sourcesUsed: [],
      timestamp: new Date().toISOString(),
      chain: "base-sepolia",
    });

    const result = await toolHandlers["trust_gate"]({
      address: TEST_ADDRESS,
    });
    const data = parseResponse(result);

    expect(data.decision).toBe("do_not_proceed");
    expect(data.reasoning).toContain("Insufficient data");
  });

  it("warns when intended_amount exceeds max for trust level", async () => {
    vi.mocked(computeTrustScore).mockResolvedValue({
      address: TEST_ADDRESS,
      score: 30,
      confidence: "medium",
      confidencePercent: 40,
      recommendation: "low_trust",
      sources: { paycrow: null, erc8004: null, moltbook: null, baseChain: null },
      sourcesUsed: ["paycrow"],
      timestamp: new Date().toISOString(),
      chain: "base-sepolia",
    });

    const result = await toolHandlers["trust_gate"]({
      address: TEST_ADDRESS,
      intended_amount_usdc: 50,
    });
    const data = parseResponse(result);

    expect(data.warning).toBeDefined();
    expect(data.warning).toContain("$50");
    expect(data.warning).toContain("$5");
    expect(data.escrowParams.intendedAmount).toBe(50);
  });

  it("returns safe default on trust scoring error", async () => {
    vi.mocked(computeTrustScore).mockRejectedValue(
      new Error("RPC unavailable"),
    );

    const result = await toolHandlers["trust_gate"]({
      address: TEST_ADDRESS,
    });
    const data = parseResponse(result);

    expect(data.decision).toBe("do_not_proceed");
    expect(data.error).toBe("RPC unavailable");
  });
});

// ── trust_score_query ───────────────────────────────────────────────

describe("trust_score_query", () => {
  it("returns full trust score breakdown", async () => {
    const mockScore = {
      address: TEST_ADDRESS,
      score: 75,
      confidence: "high" as const,
      confidencePercent: 85,
      recommendation: "high_trust" as const,
      sources: { paycrow: null, erc8004: null, moltbook: null, baseChain: null },
      sourcesUsed: ["paycrow", "erc8004", "base-chain"],
      timestamp: new Date().toISOString(),
      chain: "base-sepolia",
    };
    vi.mocked(computeTrustScore).mockResolvedValue(mockScore);

    const result = await toolHandlers["trust_score_query"]({
      address: TEST_ADDRESS,
    });
    const data = parseResponse(result);

    expect(data.score).toBe(75);
    expect(data.confidence).toBe("high");
    expect(data.recommendation).toBe("high_trust");
    expect(data.sourcesUsed).toEqual(["paycrow", "erc8004", "base-chain"]);
  });

  it("returns fallback message on error", async () => {
    vi.mocked(computeTrustScore).mockRejectedValue(
      new Error("Network timeout"),
    );

    const result = await toolHandlers["trust_score_query"]({
      address: TEST_ADDRESS,
    });
    const data = parseResponse(result);

    expect(data.error).toBe("Network timeout");
    expect(data.fallback).toContain("temporarily unavailable");
  });
});

// ── trust_onchain_quick ─────────────────────────────────────────────

describe("trust_onchain_quick", () => {
  it("returns on-chain score for agent with history", async () => {
    // getScore call
    _mocks.readContract.mockResolvedValueOnce(85n);
    // getReputation call
    _mocks.readContract.mockResolvedValueOnce([
      10n, // totalCompleted
      1n,  // totalDisputed
      0n,  // totalRefunded
      7n,  // totalAsProvider
      4n,  // totalAsClient
      50_000_000n, // totalVolume ($50)
      1700000000n, // firstSeen
      1700100000n, // lastSeen
    ]);

    const result = await toolHandlers["trust_onchain_quick"]({
      address: TEST_ADDRESS,
    });
    const data = parseResponse(result);

    expect(data.score).toBe(85);
    expect(data.source).toBe("paycrow-onchain");
    expect(data.totalEscrows).toBe(11);
    expect(data.successfulEscrows).toBe(10);
    expect(data.disputedEscrows).toBe(1);
    expect(data.recommendation).toBe("high_trust");
    expect(data.successRate).toBe("90.9%");
  });

  it("returns score=50 for unknown agent (no history)", async () => {
    _mocks.readContract.mockResolvedValueOnce(50n);
    _mocks.readContract.mockResolvedValueOnce([
      0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n,
    ]);

    const result = await toolHandlers["trust_onchain_quick"]({
      address: TEST_ADDRESS,
    });
    const data = parseResponse(result);

    expect(data.score).toBe(50);
    expect(data.recommendation).toBe("unknown");
    expect(data.message).toContain("No on-chain escrow history");
  });
});
