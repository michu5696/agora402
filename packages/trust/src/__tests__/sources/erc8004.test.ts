import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Address } from "viem";

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

import { queryErc8004 } from "../../sources/erc8004.js";

const ADDR = "0x1234567890abcdef1234567890abcdef12345678" as Address;

describe("queryErc8004", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── Not registered ───────────────────────────────────────────
  it("returns not-registered when balance is 0", async () => {
    mockReadContract.mockResolvedValueOnce(0n); // balanceOf

    const result = await queryErc8004(ADDR);
    expect(result.registered).toBe(false);
    expect(result.agentId).toBeNull();
    expect(result.score).toBe(0);
    expect(result.feedbackCount).toBe(0);
  });

  // ─── Registered with no feedback ─────────────────────────────
  it("returns base score of 30 when registered with no feedback", async () => {
    mockReadContract
      .mockResolvedValueOnce(1n) // balanceOf
      .mockResolvedValueOnce(42n) // tokenOfOwnerByIndex
      .mockResolvedValueOnce([0n, 0n, 2n]); // getSummary: count=0, value=0, decimals=2

    const result = await queryErc8004(ADDR);
    expect(result.registered).toBe(true);
    expect(result.agentId).toBe(42n);
    expect(result.feedbackCount).toBe(0);
    expect(result.score).toBe(30); // base only
  });

  // ─── Feedback count scoring ──────────────────────────────────
  it("adds up to 40 points for feedback count (4 per feedback)", async () => {
    mockReadContract
      .mockResolvedValueOnce(1n)
      .mockResolvedValueOnce(42n)
      .mockResolvedValueOnce([5n, 500n, 2n]); // 5 feedbacks, value=5.00, decimals=2

    const result = await queryErc8004(ADDR);
    // 30 base + 5*4=20 count + sentiment: avg = 5/5 = 1.0 → 1*30=30
    // Total = 30 + 20 + 30 = 80
    expect(result.score).toBe(80);
  });

  it("caps feedback count points at 40", async () => {
    mockReadContract
      .mockResolvedValueOnce(1n)
      .mockResolvedValueOnce(42n)
      .mockResolvedValueOnce([20n, 0n, 2n]); // 20 feedbacks, no positive sentiment

    const result = await queryErc8004(ADDR);
    // 30 base + min(20*4, 40)=40 + sentiment avg = 0/20 = 0 → 0
    // Total = 30 + 40 + 0 = 70
    expect(result.score).toBe(70);
  });

  // ─── Sentiment scoring ────────────────────────────────────────
  it("adds up to 30 points for positive sentiment", async () => {
    mockReadContract
      .mockResolvedValueOnce(1n)
      .mockResolvedValueOnce(42n)
      .mockResolvedValueOnce([10n, 1500n, 2n]); // 10 feedbacks, value=15.00 → avg=1.5

    const result = await queryErc8004(ADDR);
    // 30 base + min(10*4,40)=40 + min(1.5*30,30)=30 = 100
    expect(result.score).toBe(100);
  });

  it("clamps negative sentiment to 0 points", async () => {
    mockReadContract
      .mockResolvedValueOnce(1n)
      .mockResolvedValueOnce(42n)
      .mockResolvedValueOnce([3n, -300n, 2n]); // 3 feedbacks, value=-3.00 → avg=-1.0

    const result = await queryErc8004(ADDR);
    // 30 base + min(3*4,40)=12 + max(-1.0*30, 0)=0 = 42
    expect(result.score).toBe(42);
  });

  // ─── Score capping ────────────────────────────────────────────
  it("caps score at 100", async () => {
    mockReadContract
      .mockResolvedValueOnce(1n)
      .mockResolvedValueOnce(42n)
      .mockResolvedValueOnce([15n, 3000n, 2n]); // 15 feedbacks, value=30.00 → avg=2.0

    const result = await queryErc8004(ADDR);
    // 30 + min(15*4=60, 40)=40 + min(2.0*30=60, 30)=30 = 100
    expect(result.score).toBe(100);
  });

  // ─── Contract call failure ────────────────────────────────────
  it("returns not-registered on contract call failure", async () => {
    mockReadContract.mockRejectedValue(new Error("RPC timeout"));

    const result = await queryErc8004(ADDR);
    expect(result.registered).toBe(false);
    expect(result.score).toBe(0);
  });

  // ─── Decimal handling ────────────────────────────────────────
  it("handles different decimal values for feedback value", async () => {
    mockReadContract
      .mockResolvedValueOnce(1n)
      .mockResolvedValueOnce(42n)
      .mockResolvedValueOnce([2n, 150000n, 4n]); // decimals=4, value = 150000/10^4 = 15.0 → avg 7.5

    const result = await queryErc8004(ADDR);
    // 30 + min(2*4,40)=8 + min(7.5*30,30)=30 = 68
    expect(result.score).toBe(68);
  });

  // ─── Edge: 1 feedback ────────────────────────────────────────
  it("computes correct score with exactly 1 feedback", async () => {
    mockReadContract
      .mockResolvedValueOnce(1n)
      .mockResolvedValueOnce(42n)
      .mockResolvedValueOnce([1n, 50n, 2n]); // 1 feedback, value=0.50 → avg=0.5

    const result = await queryErc8004(ADDR);
    // 30 + min(1*4,40)=4 + min(0.5*30,30)=15 = 49
    expect(result.score).toBe(49);
  });

  // ─── Edge: feedbackValue is 0 with feedbackCount > 0 ─────────
  it("handles zero feedback value with positive count", async () => {
    mockReadContract
      .mockResolvedValueOnce(1n)
      .mockResolvedValueOnce(42n)
      .mockResolvedValueOnce([5n, 0n, 2n]); // 5 feedbacks, value=0

    const result = await queryErc8004(ADDR);
    // 30 + min(5*4,40)=20 + min(0*30,30)=0 = 50
    expect(result.score).toBe(50);
  });

  // ─── Output fields ───────────────────────────────────────────
  it("populates all signal fields correctly", async () => {
    mockReadContract
      .mockResolvedValueOnce(1n)
      .mockResolvedValueOnce(99n)
      .mockResolvedValueOnce([7n, 350n, 2n]); // value=3.50

    const result = await queryErc8004(ADDR);
    expect(result.registered).toBe(true);
    expect(result.agentId).toBe(99n);
    expect(result.feedbackCount).toBe(7);
    expect(result.feedbackValue).toBe(3.5);
    expect(typeof result.score).toBe("number");
  });
});
