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

vi.mock("@paycrow/verification", () => ({
  verify: vi.fn(),
}));

import { getEscrowClient } from "../../config.js";
import { computeTrustScore } from "@paycrow/trust";
import { verify } from "@paycrow/verification";
import { registerX402Tools } from "../../tools/x402.js";

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
const TEST_URL = "https://api.example.com/data";

// ── Mock EscrowClient ───────────────────────────────────────────────

const mockClient = {
  createAndFund: vi.fn(),
  release: vi.fn(),
  dispute: vi.fn(),
  getEscrow: vi.fn(),
  isExpired: vi.fn(),
};

// ── Mock fetch ──────────────────────────────────────────────────────

const originalFetch = globalThis.fetch;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getEscrowClient).mockReturnValue(mockClient as any);
  Object.keys(toolHandlers).forEach((k) => delete toolHandlers[k]);
  registerX402Tools(mockServer as any);

  // Reset fetch
  globalThis.fetch = vi.fn();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

import { afterEach } from "vitest";

// ── Helpers ─────────────────────────────────────────────────────────

function mockHighTrust() {
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
}

function mockCautionTrust() {
  vi.mocked(computeTrustScore).mockResolvedValue({
    address: TEST_ADDRESS,
    score: 10,
    confidence: "high",
    confidencePercent: 70,
    recommendation: "caution",
    sources: { paycrow: null, erc8004: null, moltbook: null, baseChain: null },
    sourcesUsed: ["paycrow"],
    timestamp: new Date().toISOString(),
    chain: "base-sepolia",
  });
}

function mockModerateTrust() {
  vi.mocked(computeTrustScore).mockResolvedValue({
    address: TEST_ADDRESS,
    score: 55,
    confidence: "medium",
    confidencePercent: 50,
    recommendation: "moderate_trust",
    sources: { paycrow: null, erc8004: null, moltbook: null, baseChain: null },
    sourcesUsed: ["base-chain"],
    timestamp: new Date().toISOString(),
    chain: "base-sepolia",
  });
}

function mockFetchSuccess(body: unknown = { result: "ok" }) {
  vi.mocked(globalThis.fetch).mockResolvedValue({
    status: 200,
    text: () => Promise.resolve(JSON.stringify(body)),
  } as Response);
}

// ── safe_pay ────────────────────────────────────────────────────────

describe("safe_pay", () => {
  it("high trust agent + successful API -> auto-release", async () => {
    mockHighTrust();
    mockFetchSuccess({ data: "delivered" });
    mockClient.createAndFund.mockResolvedValue({
      escrowId: 1n,
      txHash: "0xcreate",
    });
    mockClient.release.mockResolvedValue("0xrelease");

    const result = await toolHandlers["safe_pay"]({
      url: TEST_URL,
      seller_address: TEST_ADDRESS,
      amount_usdc: 5,
      method: "GET",
    });
    const data = parseResponse(result);

    expect(data.success).toBe(true);
    expect(data.action).toBe("auto_released");
    expect(data.escrowId).toBe("1");
    expect(data.releaseTx).toBe("0xrelease");
    expect(data.response).toEqual({ data: "delivered" });

    expect(mockClient.createAndFund).toHaveBeenCalledOnce();
    expect(mockClient.release).toHaveBeenCalledOnce();
    expect(mockClient.dispute).not.toHaveBeenCalled();
  });

  it("caution agent -> blocked", async () => {
    mockCautionTrust();

    const result = await toolHandlers["safe_pay"]({
      url: TEST_URL,
      seller_address: TEST_ADDRESS,
      amount_usdc: 5,
      method: "GET",
    });
    const data = parseResponse(result);

    expect(data.success).toBe(false);
    expect(data.blocked).toBe(true);
    expect(data.recommendation).toBe("caution");
    expect(data.message).toContain("BLOCKED");

    // Should not create any escrow
    expect(mockClient.createAndFund).not.toHaveBeenCalled();
  });

  it("amount exceeds trust cap -> blocked", async () => {
    mockModerateTrust(); // max $25

    const result = await toolHandlers["safe_pay"]({
      url: TEST_URL,
      seller_address: TEST_ADDRESS,
      amount_usdc: 50, // over the $25 cap
      method: "GET",
    });
    const data = parseResponse(result);

    expect(data.success).toBe(false);
    expect(data.step).toBe("amount_check");
    expect(data.requestedAmount).toBe(50);
    expect(data.maxAllowed).toBe(25);

    expect(mockClient.createAndFund).not.toHaveBeenCalled();
  });

  it("API call fails -> auto-dispute", async () => {
    mockHighTrust();
    vi.mocked(globalThis.fetch).mockRejectedValue(
      new Error("Connection refused"),
    );
    mockClient.createAndFund.mockResolvedValue({
      escrowId: 2n,
      txHash: "0xcreate2",
    });
    mockClient.dispute.mockResolvedValue("0xdispute2");

    const result = await toolHandlers["safe_pay"]({
      url: TEST_URL,
      seller_address: TEST_ADDRESS,
      amount_usdc: 5,
      method: "GET",
    });
    const data = parseResponse(result);

    expect(data.success).toBe(false);
    expect(data.action).toBe("auto_disputed");
    expect(data.step).toBe("api_call");
    expect(data.error).toContain("Connection refused");
    expect(data.disputeTx).toBe("0xdispute2");

    expect(mockClient.dispute).toHaveBeenCalledOnce();
    expect(mockClient.release).not.toHaveBeenCalled();
  });

  it("non-JSON response -> auto-dispute", async () => {
    mockHighTrust();
    vi.mocked(globalThis.fetch).mockResolvedValue({
      status: 200,
      text: () => Promise.resolve("this is plain text, not json"),
    } as Response);
    mockClient.createAndFund.mockResolvedValue({
      escrowId: 3n,
      txHash: "0xcreate3",
    });
    mockClient.dispute.mockResolvedValue("0xdispute3");

    const result = await toolHandlers["safe_pay"]({
      url: TEST_URL,
      seller_address: TEST_ADDRESS,
      amount_usdc: 5,
      method: "GET",
    });
    const data = parseResponse(result);

    expect(data.success).toBe(false);
    expect(data.action).toBe("auto_disputed");
    expect(data.disputeReason).toContain("not valid JSON");
  });

  it("HTTP error -> auto-dispute", async () => {
    mockHighTrust();
    vi.mocked(globalThis.fetch).mockResolvedValue({
      status: 500,
      text: () => Promise.resolve(JSON.stringify({ error: "Internal error" })),
    } as Response);
    mockClient.createAndFund.mockResolvedValue({
      escrowId: 4n,
      txHash: "0xcreate4",
    });
    mockClient.dispute.mockResolvedValue("0xdispute4");

    const result = await toolHandlers["safe_pay"]({
      url: TEST_URL,
      seller_address: TEST_ADDRESS,
      amount_usdc: 5,
      method: "GET",
    });
    const data = parseResponse(result);

    expect(data.success).toBe(false);
    expect(data.action).toBe("auto_disputed");
    expect(data.httpStatus).toBe(500);
    expect(data.disputeReason).toContain("HTTP 500");
  });

  it("trust check failure -> refuse to pay", async () => {
    vi.mocked(computeTrustScore).mockRejectedValue(
      new Error("RPC unavailable"),
    );

    const result = await toolHandlers["safe_pay"]({
      url: TEST_URL,
      seller_address: TEST_ADDRESS,
      amount_usdc: 5,
      method: "GET",
    });
    const data = parseResponse(result);

    expect(data.success).toBe(false);
    expect(data.step).toBe("trust_check");
    expect(data.error).toContain("Could not verify seller trust");

    expect(mockClient.createAndFund).not.toHaveBeenCalled();
  });
});

// ── x402_protected_call ─────────────────────────────────────────────

describe("x402_protected_call", () => {
  it("schema verification passes -> release", async () => {
    const schema = JSON.stringify({
      type: "object",
      properties: { data: { type: "string" } },
      required: ["data"],
    });

    mockFetchSuccess({ data: "result" });
    mockClient.createAndFund.mockResolvedValue({
      escrowId: 10n,
      txHash: "0xcreate10",
    });
    mockClient.release.mockResolvedValue("0xrelease10");
    vi.mocked(verify).mockReturnValue({
      valid: true,
      strategy: "schema",
      details: "Response matches JSON Schema",
    });

    const result = await toolHandlers["x402_protected_call"]({
      url: TEST_URL,
      method: "GET",
      seller_address: TEST_ADDRESS,
      amount_usdc: 10,
      timelock_minutes: 30,
      verification_strategy: "schema",
      verification_data: schema,
    });
    const data = parseResponse(result);

    expect(data.success).toBe(true);
    expect(data.action).toBe("auto_released");
    expect(data.verification.strategy).toBe("schema");
    expect(data.verification.valid).toBe(true);
    expect(data.releaseTx).toBe("0xrelease10");

    expect(mockClient.release).toHaveBeenCalledWith(10n);
    expect(mockClient.dispute).not.toHaveBeenCalled();
  });

  it("schema verification fails -> dispute", async () => {
    const schema = JSON.stringify({
      type: "object",
      properties: { count: { type: "number" } },
      required: ["count"],
    });

    mockFetchSuccess({ wrong: "shape" });
    mockClient.createAndFund.mockResolvedValue({
      escrowId: 11n,
      txHash: "0xcreate11",
    });
    mockClient.dispute.mockResolvedValue("0xdispute11");
    vi.mocked(verify).mockReturnValue({
      valid: false,
      strategy: "schema",
      details: "Schema validation failed: /count is required",
    });

    const result = await toolHandlers["x402_protected_call"]({
      url: TEST_URL,
      method: "GET",
      seller_address: TEST_ADDRESS,
      amount_usdc: 10,
      timelock_minutes: 30,
      verification_strategy: "schema",
      verification_data: schema,
    });
    const data = parseResponse(result);

    expect(data.success).toBe(false);
    expect(data.action).toBe("auto_disputed");
    expect(data.verification.strategy).toBe("schema");
    expect(data.verification.valid).toBe(false);
    expect(data.disputeTx).toBe("0xdispute11");

    expect(mockClient.dispute).toHaveBeenCalledWith(11n);
    expect(mockClient.release).not.toHaveBeenCalled();
  });

  it("hash-lock verification passes -> release", async () => {
    const expectedHash = "abc123hash";

    mockFetchSuccess({ key: "val" });
    mockClient.createAndFund.mockResolvedValue({
      escrowId: 12n,
      txHash: "0xcreate12",
    });
    mockClient.release.mockResolvedValue("0xrelease12");
    vi.mocked(verify).mockReturnValue({
      valid: true,
      strategy: "hash-lock",
      details: "Response hash matches expected",
    });

    const result = await toolHandlers["x402_protected_call"]({
      url: TEST_URL,
      method: "GET",
      seller_address: TEST_ADDRESS,
      amount_usdc: 5,
      timelock_minutes: 15,
      verification_strategy: "hash-lock",
      verification_data: expectedHash,
    });
    const data = parseResponse(result);

    expect(data.success).toBe(true);
    expect(data.action).toBe("auto_released");
    expect(data.verification.strategy).toBe("hash-lock");
    expect(data.verification.valid).toBe(true);

    expect(verify).toHaveBeenCalledWith(
      "hash-lock",
      { key: "val" },
      expectedHash,
    );
  });

  it("API call failure -> auto-dispute", async () => {
    vi.mocked(globalThis.fetch).mockRejectedValue(
      new Error("DNS resolution failed"),
    );
    mockClient.createAndFund.mockResolvedValue({
      escrowId: 13n,
      txHash: "0xcreate13",
    });
    mockClient.dispute.mockResolvedValue("0xdispute13");

    const result = await toolHandlers["x402_protected_call"]({
      url: TEST_URL,
      method: "GET",
      seller_address: TEST_ADDRESS,
      amount_usdc: 5,
      timelock_minutes: 30,
      verification_strategy: "schema",
      verification_data: "{}",
    });
    const data = parseResponse(result);

    expect(data.success).toBe(false);
    expect(data.step).toBe("api_call");
    expect(data.action).toBe("auto_disputed");
    expect(data.error).toContain("DNS resolution failed");
    expect(data.disputeTx).toBe("0xdispute13");
  });
});
