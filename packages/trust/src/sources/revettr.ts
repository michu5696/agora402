/**
 * Revettr API integration for agent trust scoring.
 *
 * Revettr is the compliance_risk issuer in the A2A #1734 Trust Evidence
 * Format RFC. It covers the counterparty risk slot that no other agent
 * trust provider fills:
 *   - Sanctions screening (OFAC, EU, UN)
 *   - Wallet reputation across multiple chains (Base, Ethereum, BSC,
 *     Polygon, Arbitrum, plus extra chains via InsumerAPI enrichment)
 *   - Domain hygiene (WHOIS, DNS, SSL)
 *   - IP reputation (geolocation, VPN, datacenter detection)
 *
 * Calls POST ${REVETTR_API_URL}/v1/attest (free tier, 10 req/min per IP)
 * which returns a signed JWS attestation envelope. We pass the composite
 * 0-100 score straight through to the TrustSignal and surface tier and
 * flags as typed fields for downstream consumers.
 *
 * Configuration:
 *   REVETTR_API_URL — base URL override (default: https://revettr.com)
 *   REVETTR_API_KEY — optional, forwarded as x-api-key header when set.
 *                     Not required on the free tier today, forward
 *                     compatible with a future paid or partner tier.
 *
 * Discovery doc: https://revettr.com/.well-known/risk-check.json
 * JWKS:          https://revettr.com/.well-known/jwks.json
 * DID:           did:web:revettr.com
 * Algorithm:     ES256 (kid: revettr-attest-v1)
 *
 * The full JWS is attached to the returned signal so paycrow can verify
 * it out of band against the published JWKS if stronger guarantees than
 * the HTTPS channel to revettr.com are required.
 */

import { fetchWithRetry } from "../utils/retry.js";

export type RevettrTier = "low" | "medium" | "high" | "critical";

export interface RevettrSignal {
  found: boolean;
  /** Composite risk tier returned by Revettr */
  tier: RevettrTier | null;
  /** Risk indicator flags (e.g. wallet_established, sanctions_clear) */
  flags: string[];
  /** Full compact JWS (RFC 7515, ES256) for out-of-band verification */
  jws: string | null;
  /** Key ID from the attestation envelope */
  kid: string | null;
  /** JWKS URL published by Revettr for JWS verification */
  jwksUrl: string | null;
  /** Revocations list URL published by Revettr */
  revocationsUrl: string | null;
  /** Issuer DID (did:web:revettr.com) */
  issuerDid: string | null;
  /** Revettr's own confidence score for the attestation (0-1) */
  attestationConfidence: number;
  /** Normalized score 0-100 (pass-through from Revettr's composite score) */
  score: number;
}

interface RevettrAttestationPayload {
  iss?: string;
  sub?: string;
  iat?: number;
  exp?: number;
  category?: string;
  attestation_type?: string;
  score?: number;
  tier?: RevettrTier;
  confidence?: number;
  flags?: string[];
  signals?: Record<string, unknown>;
  input_hash?: string;
  timestamp?: string;
}

interface RevettrAttestation {
  type?: string;
  confidence?: number;
  payload?: RevettrAttestationPayload;
}

interface RevettrProvider {
  id?: string;
  category?: string;
}

interface RevettrAttestResponse {
  provider?: RevettrProvider;
  attestation?: RevettrAttestation;
  jws?: string;
  signature?: string;
  kid?: string;
  algorithm?: string;
  jwks_url?: string;
  revocations_url?: string;
}

export interface RevettrQueryInput {
  /** EVM wallet address (0x...) */
  wallet?: string;
  /** Counterparty domain */
  domain?: string;
  /** Counterparty IP address */
  ip?: string;
  /** Counterparty company name */
  company?: string;
  /** Optional non-EVM wallet addresses */
  solanaWallet?: string;
  xrplWallet?: string;
  bitcoinWallet?: string;
  stellarWallet?: string;
}

const DEFAULT_REVETTR_BASE_URL = "https://revettr.com";

const NOT_FOUND: RevettrSignal = {
  found: false,
  tier: null,
  flags: [],
  jws: null,
  kid: null,
  jwksUrl: null,
  revocationsUrl: null,
  issuerDid: null,
  attestationConfidence: 0,
  score: 0,
};

/**
 * Query Revettr for a counterparty risk attestation.
 *
 * At least one of wallet/domain/ip/company should be supplied. Revettr
 * will run all applicable signal groups and return a signed attestation
 * envelope with a composite 0-100 score plus tier and flags.
 *
 * Returns a not-found signal on any error (network failure, HTTP
 * non-200, missing fields) so the trust engine can degrade gracefully.
 */
export async function queryRevettr(
  input: RevettrQueryInput,
  apiKey?: string
): Promise<RevettrSignal> {
  const key = apiKey ?? process.env.REVETTR_API_KEY;
  const baseUrl = process.env.REVETTR_API_URL ?? DEFAULT_REVETTR_BASE_URL;

  const body: Record<string, string> = {};
  if (input.wallet) body.wallet_address = input.wallet;
  if (input.domain) body.domain = input.domain;
  if (input.ip) body.ip = input.ip;
  if (input.company) body.company_name = input.company;
  if (input.solanaWallet) body.solana_wallet = input.solanaWallet;
  if (input.xrplWallet) body.xrpl_wallet = input.xrplWallet;
  if (input.bitcoinWallet) body.bitcoin_wallet = input.bitcoinWallet;
  if (input.stellarWallet) body.stellar_wallet = input.stellarWallet;

  if (Object.keys(body).length === 0) {
    return NOT_FOUND;
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (key) {
    headers["x-api-key"] = key;
  }

  try {
    const res = await fetchWithRetry(
      `${baseUrl}/v1/attest`,
      {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      },
      { maxAttempts: 2, timeoutMs: 8000, baseDelayMs: 500 }
    );

    if (!res.ok) {
      return NOT_FOUND;
    }

    const data = (await res.json()) as RevettrAttestResponse;
    const payload = data?.attestation?.payload;

    if (!payload || typeof payload.score !== "number") {
      return NOT_FOUND;
    }

    // Revettr's composite score is already 0-100. Pass it through directly
    // rather than re-mapping from tier, which would discard precision.
    const score = Math.min(Math.max(Math.round(payload.score), 0), 100);

    return {
      found: true,
      tier: payload.tier ?? null,
      flags: Array.isArray(payload.flags) ? payload.flags : [],
      jws: data.jws ?? null,
      kid: data.kid ?? null,
      jwksUrl: data.jwks_url ?? null,
      revocationsUrl: data.revocations_url ?? null,
      issuerDid: data.provider?.id ?? null,
      attestationConfidence:
        typeof data.attestation?.confidence === "number"
          ? data.attestation.confidence
          : 0,
      score,
    };
  } catch {
    return NOT_FOUND;
  }
}
