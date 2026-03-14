import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../config.js", () => ({
  getEscrowClient: vi.fn(),
  getChain: vi.fn(() => ({ id: 84532, name: "Base Sepolia" })),
  getRpcUrl: vi.fn(() => "https://sepolia.base.org"),
  getChainName: vi.fn(() => "base-sepolia"),
  getReputationAddress: vi.fn(
    () => "0x2A216a829574e88dD632e7C95660d43bCE627CDf",
  ),
}));

import { getEscrowClient } from "../../config.js";
import { registerEscrowTools } from "../../tools/escrow.js";

// ── Capture tool handlers via mock McpServer ────────────────────────

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
}>;

const toolHandlers: Record<string, ToolHandler> = {};
const mockServer = {
  tool: vi.fn(
    (
      name: string,
      _desc: string,
      _schema: unknown,
      handler: ToolHandler,
    ) => {
      toolHandlers[name] = handler;
    },
  ),
};

function parseResponse(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0].text);
}

// ── Mock EscrowClient ───────────────────────────────────────────────

const mockClient = {
  createAndFund: vi.fn(),
  release: vi.fn(),
  dispute: vi.fn(),
  getEscrow: vi.fn(),
  isExpired: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getEscrowClient).mockReturnValue(mockClient as any);

  // Re-register tools so handlers use fresh mocks
  Object.keys(toolHandlers).forEach((k) => delete toolHandlers[k]);
  registerEscrowTools(mockServer as any);
});

// ── Tests ───────────────────────────────────────────────────────────

describe("escrow_create", () => {
  it("creates an escrow and returns success JSON", async () => {
    mockClient.createAndFund.mockResolvedValue({
      escrowId: 1n,
      txHash: "0xabc123",
    });

    const result = await toolHandlers["escrow_create"]({
      seller: "0x1234567890abcdef1234567890abcdef12345678",
      amount_usdc: 5,
      timelock_minutes: 30,
      service_url: "https://api.example.com/data",
    });

    const data = parseResponse(result);

    expect(data.success).toBe(true);
    expect(data.escrowId).toBe("1");
    expect(data.amount).toBe("$5.00");
    expect(data.seller).toBe("0x1234567890abcdef1234567890abcdef12345678");
    expect(data.txHash).toBe("0xabc123");
    expect(data.expiresInMinutes).toBe(30);
    expect(data.message).toContain("Escrow #1 created");

    expect(mockClient.createAndFund).toHaveBeenCalledOnce();
    const callArgs = mockClient.createAndFund.mock.calls[0][0];
    expect(callArgs.seller).toBe(
      "0x1234567890abcdef1234567890abcdef12345678",
    );
    expect(callArgs.amount).toBe(5_000_000n);
    expect(callArgs.timelockDuration).toBe(1800n);
  });

  it("passes amount bounds to createAndFund correctly", async () => {
    // Test minimum bound (0.1 USDC)
    mockClient.createAndFund.mockResolvedValue({
      escrowId: 2n,
      txHash: "0xmin",
    });

    await toolHandlers["escrow_create"]({
      seller: "0xaaaa",
      amount_usdc: 0.1,
      timelock_minutes: 5,
      service_url: "https://example.com",
    });

    expect(mockClient.createAndFund.mock.calls[0][0].amount).toBe(100_000n);

    // Test maximum bound (100 USDC)
    mockClient.createAndFund.mockResolvedValue({
      escrowId: 3n,
      txHash: "0xmax",
    });

    await toolHandlers["escrow_create"]({
      seller: "0xbbbb",
      amount_usdc: 100,
      timelock_minutes: 60,
      service_url: "https://example.com",
    });

    expect(mockClient.createAndFund.mock.calls[1][0].amount).toBe(
      100_000_000n,
    );
  });
});

describe("escrow_release", () => {
  it("releases escrow and returns success", async () => {
    mockClient.release.mockResolvedValue("0xdef456");

    const result = await toolHandlers["escrow_release"]({
      escrow_id: "42",
    });

    const data = parseResponse(result);

    expect(data.success).toBe(true);
    expect(data.escrowId).toBe("42");
    expect(data.action).toBe("released");
    expect(data.txHash).toBe("0xdef456");
    expect(data.message).toContain("released");

    expect(mockClient.release).toHaveBeenCalledWith(42n);
  });
});

describe("escrow_dispute", () => {
  it("disputes escrow and includes reason in response", async () => {
    mockClient.dispute.mockResolvedValue("0xghi789");

    const result = await toolHandlers["escrow_dispute"]({
      escrow_id: "7",
      reason: "Service was not delivered",
    });

    const data = parseResponse(result);

    expect(data.success).toBe(true);
    expect(data.escrowId).toBe("7");
    expect(data.action).toBe("disputed");
    expect(data.reason).toBe("Service was not delivered");
    expect(data.txHash).toBe("0xghi789");
    expect(data.message).toContain("disputed");
    expect(data.message).toContain("Service was not delivered");

    expect(mockClient.dispute).toHaveBeenCalledWith(7n);
  });
});

describe("escrow_status", () => {
  it("returns formatted escrow state", async () => {
    const now = BigInt(Math.floor(Date.now() / 1000));
    const expires = now + 1800n;

    mockClient.getEscrow.mockResolvedValue({
      state: 1, // Funded
      buyer: "0xbuyer",
      seller: "0xseller",
      amount: 10_000_000n,
      createdAt: now,
      expiresAt: expires,
    });
    mockClient.isExpired.mockResolvedValue(false);

    const result = await toolHandlers["escrow_status"]({
      escrow_id: "5",
    });

    const data = parseResponse(result);

    expect(data.escrowId).toBe("5");
    expect(data.state).toBe("Funded");
    expect(data.buyer).toBe("0xbuyer");
    expect(data.seller).toBe("0xseller");
    expect(data.amount).toBe("$10.00");
    expect(data.isExpired).toBe(false);

    expect(mockClient.getEscrow).toHaveBeenCalledWith(5n);
    expect(mockClient.isExpired).toHaveBeenCalledWith(5n);
  });

  it("maps all state indices to correct names", async () => {
    const stateNames = [
      "Created",
      "Funded",
      "Released",
      "Disputed",
      "Resolved",
      "Expired",
      "Refunded",
    ];

    for (let i = 0; i < stateNames.length; i++) {
      mockClient.getEscrow.mockResolvedValue({
        state: i,
        buyer: "0xbuyer",
        seller: "0xseller",
        amount: 1_000_000n,
        createdAt: 1700000000n,
        expiresAt: 1700001800n,
      });
      mockClient.isExpired.mockResolvedValue(false);

      const result = await toolHandlers["escrow_status"]({
        escrow_id: "1",
      });

      const data = parseResponse(result);
      expect(data.state).toBe(stateNames[i]);
    }
  });
});
