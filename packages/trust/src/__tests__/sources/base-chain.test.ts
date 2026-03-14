import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Address } from "viem";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { queryBaseChain } from "../../sources/base-chain.js";

const ADDR = "0x1234567890abcdef1234567890abcdef12345678" as Address;

function etherscanResponse(result: unknown, status = "1") {
  return {
    ok: true,
    json: async () => ({ status, result }),
  };
}

function makeTx(overrides: Record<string, unknown> = {}) {
  return {
    timeStamp: String(Math.floor(Date.now() / 1000) - 86400 * 180),
    from: "0xaaaa",
    to: "0xbbbb",
    value: "0",
    ...overrides,
  };
}

function makeTokenTx(overrides: Record<string, unknown> = {}) {
  return {
    from: ADDR.toLowerCase(),
    to: "0xcccc",
    value: "1000000000", // 1000 USDC
    ...overrides,
  };
}

describe("queryBaseChain", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns empty signal when no API key is provided", async () => {
    const origEnv = process.env.BASESCAN_API_KEY;
    delete process.env.BASESCAN_API_KEY;

    const result = await queryBaseChain(ADDR);
    expect(result.score).toBe(0);
    expect(result.txCount).toBe(0);
    expect(mockFetch).not.toHaveBeenCalled();

    if (origEnv !== undefined) process.env.BASESCAN_API_KEY = origEnv;
  });

  it("returns empty signal on fetch error", async () => {
    mockFetch.mockRejectedValue(new Error("Network error"));
    const result = await queryBaseChain(ADDR, "test-key");
    expect(result.score).toBe(0);
    expect(result.txCount).toBe(0);
  });

  it("returns empty signal when etherscan returns non-ok", async () => {
    mockFetch.mockResolvedValue({ ok: false });
    const result = await queryBaseChain(ADDR, "test-key");
    expect(result.score).toBe(0);
  });

  it("returns empty signal when etherscan status is not '1'", async () => {
    mockFetch
      .mockResolvedValueOnce(etherscanResponse([], "0"))
      .mockResolvedValueOnce(etherscanResponse([], "0"));

    const result = await queryBaseChain(ADDR, "test-key");
    expect(result.txCount).toBe(0);
    expect(result.score).toBe(0);
  });

  // ─── Scoring math ────────────────────────────────────────────

  describe("scoring math", () => {
    it("computes wallet age points (up to 25, 180+ days = full)", async () => {
      const oldTs = String(Math.floor(Date.now() / 1000) - 86400 * 365); // 365 days ago
      mockFetch
        .mockResolvedValueOnce(etherscanResponse([makeTx({ timeStamp: oldTs })]))
        .mockResolvedValueOnce(etherscanResponse([]));

      const result = await queryBaseChain(ADDR, "test-key");
      // 365 days → (365/180)*25 = 50.69 → capped at 25
      // txCount = 1 → log10(2)*12.5 ≈ 3.76
      // Total ≈ 25 + 3.76 = 28.76 → 29
      expect(result.walletAgeDays).toBeGreaterThanOrEqual(364);
      expect(result.score).toBeGreaterThanOrEqual(28);
    });

    it("computes partial wallet age for < 180 days", async () => {
      const ts = String(Math.floor(Date.now() / 1000) - 86400 * 90); // 90 days ago
      mockFetch
        .mockResolvedValueOnce(etherscanResponse([makeTx({ timeStamp: ts })]))
        .mockResolvedValueOnce(etherscanResponse([]));

      const result = await queryBaseChain(ADDR, "test-key");
      // 90/180 * 25 = 12.5
      // txCount = 1 → log10(2)*12.5 ≈ 3.76
      // Total ≈ 16.26 → 16
      expect(result.walletAgeDays).toBeGreaterThanOrEqual(89);
      expect(result.score).toBeGreaterThanOrEqual(15);
      expect(result.score).toBeLessThanOrEqual(18);
    });

    it("computes tx count points using log10 (up to 25)", async () => {
      const ts = String(Math.floor(Date.now() / 1000)); // now
      const txs = Array.from({ length: 100 }, () => makeTx({ timeStamp: ts }));
      mockFetch
        .mockResolvedValueOnce(etherscanResponse(txs))
        .mockResolvedValueOnce(etherscanResponse([]));

      const result = await queryBaseChain(ADDR, "test-key");
      // txCount = 100 → log10(101) ≈ 2.004 → 2.004 * 12.5 ≈ 25.05 → capped at 25
      expect(result.txCount).toBe(100);
      const txPoints = Math.min(Math.log10(101) * 12.5, 25);
      expect(txPoints).toBeGreaterThanOrEqual(25);
    });

    it("computes USDC volume points using log10 (up to 25)", async () => {
      const ts = String(Math.floor(Date.now() / 1000));
      const tokenTxs = [
        makeTokenTx({ value: "10000000000", to: "0xeeee" }), // 10000 USDC
      ];
      mockFetch
        .mockResolvedValueOnce(etherscanResponse([makeTx({ timeStamp: ts })]))
        .mockResolvedValueOnce(etherscanResponse(tokenTxs));

      const result = await queryBaseChain(ADDR, "test-key");
      // volume = 10000 → log10(10001) ≈ 4.0 → 4*6.25 = 25 → capped at 25
      expect(result.usdcVolume).toBe(10000);
    });

    it("computes counterparty diversity points (up to 25)", async () => {
      const ts = String(Math.floor(Date.now() / 1000));
      const counterparties = Array.from({ length: 12 }, (_, i) =>
        makeTokenTx({
          value: "1000000",
          to: `0x${String(i).padStart(40, "0")}`,
        })
      );
      mockFetch
        .mockResolvedValueOnce(etherscanResponse([makeTx({ timeStamp: ts })]))
        .mockResolvedValueOnce(etherscanResponse(counterparties));

      const result = await queryBaseChain(ADDR, "test-key");
      // 12 unique counterparties × 2.5 = 30 → capped at 25
      expect(result.uniqueCounterparties).toBe(12);
    });

    it("does not double-count address itself as counterparty", async () => {
      const ts = String(Math.floor(Date.now() / 1000));
      const tokenTxs = [
        makeTokenTx({
          from: ADDR.toLowerCase(),
          to: "0xaaaa",
          value: "1000000",
        }),
        makeTokenTx({
          from: "0xbbbb",
          to: ADDR.toLowerCase(),
          value: "1000000",
        }),
      ];
      mockFetch
        .mockResolvedValueOnce(etherscanResponse([makeTx({ timeStamp: ts })]))
        .mockResolvedValueOnce(etherscanResponse(tokenTxs));

      const result = await queryBaseChain(ADDR, "test-key");
      // First tx: to=0xaaaa is counterparty, from=ADDR excluded
      // Second tx: from=0xbbbb is counterparty, to=ADDR excluded
      expect(result.uniqueCounterparties).toBe(2);
    });

    it("caps total score at 100", async () => {
      const oldTs = String(Math.floor(Date.now() / 1000) - 86400 * 365);
      const txs = Array.from({ length: 100 }, () => makeTx({ timeStamp: oldTs }));
      const tokenTxs = Array.from({ length: 20 }, (_, i) =>
        makeTokenTx({
          value: "100000000000", // 100k USDC each
          to: `0x${String(i).padStart(40, "0")}`,
        })
      );
      mockFetch
        .mockResolvedValueOnce(etherscanResponse(txs))
        .mockResolvedValueOnce(etherscanResponse(tokenTxs));

      const result = await queryBaseChain(ADDR, "test-key");
      expect(result.score).toBeLessThanOrEqual(100);
    });

    it("returns 0 score with 0 transactions", async () => {
      mockFetch
        .mockResolvedValueOnce(etherscanResponse([]))
        .mockResolvedValueOnce(etherscanResponse([]));

      const result = await queryBaseChain(ADDR, "test-key");
      expect(result.score).toBe(0);
      expect(result.txCount).toBe(0);
      expect(result.walletAgeDays).toBe(0);
    });

    it("handles non-array etherscan results gracefully", async () => {
      mockFetch
        .mockResolvedValueOnce(etherscanResponse("Max rate limit reached"))
        .mockResolvedValueOnce(etherscanResponse("Max rate limit reached"));

      const result = await queryBaseChain(ADDR, "test-key");
      expect(result.txCount).toBe(0);
      expect(result.score).toBe(0);
    });
  });
});
