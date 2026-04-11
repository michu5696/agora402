import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { queryRevettr } from "../../sources/revettr.js";

function makeAttestResponse(overrides: {
  score?: number;
  tier?: "low" | "medium" | "high" | "critical";
  flags?: string[];
  omitFlags?: boolean;
  jws?: string;
  confidence?: number;
  providerId?: string;
  omitPayload?: boolean;
  omitScore?: boolean;
}) {
  const payload: Record<string, unknown> = {
    iss: "did:web:revettr.com",
    sub: "0xd8da6bf26964af9d7eed9e03e53415d37aa96045",
    iat: 1775881387,
    exp: 1775884987,
    category: "compliance_risk",
    attestation_type: "compliance_risk",
    tier: overrides.tier ?? "low",
    confidence: 0.2,
    signals: { domain: null, ip: null, sanctions: null, wallet: {} },
    input_hash: "f442a24de50fa0174f0dd7549b9374be183603437d952fb5525b9e1163a6cbc1",
    timestamp: "2026-04-11T04:23:07.645505+00:00",
  };
  if (!overrides.omitScore) {
    payload.score = overrides.score ?? 97;
  }
  if (!overrides.omitFlags) {
    payload.flags = overrides.flags ?? ["wallet_high_activity", "wallet_established"];
  }

  return {
    ok: true,
    json: async () => ({
      "@context": ["https://www.w3.org/ns/credentials/v2"],
      type: "TrustAttestation",
      version: "1.0.0",
      provider: {
        id: overrides.providerId ?? "did:web:revettr.com",
        category: "compliance_risk",
      },
      subject: { id: "0xd8da6bf26964af9d7eed9e03e53415d37aa96045" },
      attestation: overrides.omitPayload
        ? undefined
        : {
            type: "ComplianceRiskAttestation",
            confidence: overrides.confidence ?? 0.2,
            payload,
          },
      jws: overrides.jws ?? "eyJhbGciOiJFUzI1NiJ9.payload.signature",
      signature: "sig",
      kid: "revettr-attest-v1",
      algorithm: "ES256",
      jwks_url: "https://revettr.com/.well-known/jwks.json",
      revocations_url: "https://revettr.com/.well-known/revocations.json",
    }),
  };
}

describe("queryRevettr", () => {
  const ORIG_API_KEY = process.env.REVETTR_API_KEY;
  const ORIG_API_URL = process.env.REVETTR_API_URL;

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.REVETTR_API_KEY;
    delete process.env.REVETTR_API_URL;
  });

  afterEach(() => {
    if (ORIG_API_KEY !== undefined) process.env.REVETTR_API_KEY = ORIG_API_KEY;
    if (ORIG_API_URL !== undefined) process.env.REVETTR_API_URL = ORIG_API_URL;
  });

  it("returns not-found when no input fields are provided", async () => {
    const result = await queryRevettr({});
    expect(result.found).toBe(false);
    expect(result.score).toBe(0);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns not-found on fetch error", async () => {
    mockFetch.mockRejectedValue(new Error("Network error"));
    const result = await queryRevettr({ wallet: "0xabc" });
    expect(result.found).toBe(false);
    expect(result.score).toBe(0);
  });

  it("returns not-found on non-ok response", async () => {
    mockFetch.mockResolvedValue({ ok: false, json: async () => ({}) });
    const result = await queryRevettr({ wallet: "0xabc" });
    expect(result.found).toBe(false);
  });

  it("returns not-found when attestation payload is missing", async () => {
    mockFetch.mockResolvedValueOnce(makeAttestResponse({ omitPayload: true }));
    const result = await queryRevettr({ wallet: "0xabc" });
    expect(result.found).toBe(false);
    expect(result.score).toBe(0);
  });

  it("returns not-found when payload score is missing", async () => {
    mockFetch.mockResolvedValueOnce(makeAttestResponse({ omitScore: true }));
    const result = await queryRevettr({ wallet: "0xabc" });
    expect(result.found).toBe(false);
  });

  it("passes composite score through unchanged", async () => {
    mockFetch.mockResolvedValueOnce(makeAttestResponse({ score: 73 }));
    const result = await queryRevettr({ wallet: "0xabc" });
    expect(result.found).toBe(true);
    expect(result.score).toBe(73);
  });

  it("extracts tier, flags, jws, and provider metadata", async () => {
    mockFetch.mockResolvedValueOnce(
      makeAttestResponse({
        score: 40,
        tier: "high",
        flags: ["sanctions_hit", "wallet_new"],
        jws: "eyJhbGciOiJFUzI1NiJ9.custom.sig",
        confidence: 0.85,
      })
    );
    const result = await queryRevettr({ wallet: "0xabc", domain: "foo.com" });
    expect(result.tier).toBe("high");
    expect(result.flags).toEqual(["sanctions_hit", "wallet_new"]);
    expect(result.jws).toBe("eyJhbGciOiJFUzI1NiJ9.custom.sig");
    expect(result.kid).toBe("revettr-attest-v1");
    expect(result.jwksUrl).toBe("https://revettr.com/.well-known/jwks.json");
    expect(result.revocationsUrl).toBe("https://revettr.com/.well-known/revocations.json");
    expect(result.issuerDid).toBe("did:web:revettr.com");
    expect(result.attestationConfidence).toBeCloseTo(0.85);
  });

  it("clamps score into 0-100 range", async () => {
    mockFetch.mockResolvedValueOnce(makeAttestResponse({ score: 150 }));
    const tooHigh = await queryRevettr({ wallet: "0xabc" });
    expect(tooHigh.score).toBe(100);

    mockFetch.mockResolvedValueOnce(makeAttestResponse({ score: -10 }));
    const tooLow = await queryRevettr({ wallet: "0xabc" });
    expect(tooLow.score).toBe(0);
  });

  it("maps paycrow input field names to Revettr request body", async () => {
    mockFetch.mockResolvedValueOnce(makeAttestResponse({ score: 50 }));
    await queryRevettr({
      wallet: "0xabc",
      domain: "example.com",
      ip: "1.2.3.4",
      company: "Acme",
    });

    const call = mockFetch.mock.calls[0];
    expect(call[0]).toBe("https://revettr.com/v1/attest");
    const init = call[1];
    expect(init.method).toBe("POST");
    const parsedBody = JSON.parse(init.body);
    expect(parsedBody.wallet_address).toBe("0xabc");
    expect(parsedBody.domain).toBe("example.com");
    expect(parsedBody.ip).toBe("1.2.3.4");
    expect(parsedBody.company_name).toBe("Acme");
  });

  it("forwards REVETTR_API_KEY as x-api-key header when set", async () => {
    process.env.REVETTR_API_KEY = "secret-key";
    mockFetch.mockResolvedValueOnce(makeAttestResponse({ score: 50 }));

    await queryRevettr({ wallet: "0xabc" });
    const headers = mockFetch.mock.calls[0][1].headers;
    expect(headers["x-api-key"]).toBe("secret-key");
  });

  it("omits x-api-key header when REVETTR_API_KEY is unset", async () => {
    mockFetch.mockResolvedValueOnce(makeAttestResponse({ score: 50 }));

    await queryRevettr({ wallet: "0xabc" });
    const headers = mockFetch.mock.calls[0][1].headers;
    expect(headers["x-api-key"]).toBeUndefined();
  });

  it("prefers explicit apiKey argument over env var", async () => {
    process.env.REVETTR_API_KEY = "env-key";
    mockFetch.mockResolvedValueOnce(makeAttestResponse({ score: 50 }));

    await queryRevettr({ wallet: "0xabc" }, "arg-key");
    const headers = mockFetch.mock.calls[0][1].headers;
    expect(headers["x-api-key"]).toBe("arg-key");
  });

  it("honors REVETTR_API_URL override", async () => {
    process.env.REVETTR_API_URL = "https://staging.revettr.example";
    mockFetch.mockResolvedValueOnce(makeAttestResponse({ score: 50 }));

    await queryRevettr({ wallet: "0xabc" });
    expect(mockFetch.mock.calls[0][0]).toBe("https://staging.revettr.example/v1/attest");
  });

  it("includes optional non-EVM wallet fields when provided", async () => {
    mockFetch.mockResolvedValueOnce(makeAttestResponse({ score: 50 }));
    await queryRevettr({
      wallet: "0xabc",
      solanaWallet: "SoLxxx",
      xrplWallet: "rXxx",
      bitcoinWallet: "bc1xxx",
      stellarWallet: "GAxxx",
    });

    const parsedBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(parsedBody.solana_wallet).toBe("SoLxxx");
    expect(parsedBody.xrpl_wallet).toBe("rXxx");
    expect(parsedBody.bitcoin_wallet).toBe("bc1xxx");
    expect(parsedBody.stellar_wallet).toBe("GAxxx");
  });

  it("returns empty flags array when flags field is missing", async () => {
    mockFetch.mockResolvedValueOnce(
      makeAttestResponse({ score: 80, omitFlags: true })
    );
    const result = await queryRevettr({ wallet: "0xabc" });
    expect(result.flags).toEqual([]);
  });
});
