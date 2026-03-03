import { z } from "zod";

export const CreateEscrowSchema = z
  .object({
    seller: z.string().describe("Ethereum address of the seller/service provider"),
    amount_usdc: z
      .number()
      .min(0.1)
      .max(100)
      .describe("Amount in USDC (e.g., 5.00 for $5)"),
    timelock_minutes: z
      .number()
      .min(5)
      .max(43200)
      .default(30)
      .describe("Minutes until escrow expires and auto-refunds (default: 30)"),
    service_url: z
      .string()
      .describe("URL or identifier of the service being purchased"),
  })
  .strip()
  .describe("Create a USDC escrow to protect a transaction");

export const ReleaseEscrowSchema = z
  .object({
    escrow_id: z.string().describe("The escrow ID to release"),
  })
  .strip()
  .describe("Confirm delivery and release escrowed USDC to the seller");

export const DisputeEscrowSchema = z
  .object({
    escrow_id: z.string().describe("The escrow ID to dispute"),
    reason: z.string().describe("Brief description of the problem"),
  })
  .strip()
  .describe("Flag bad delivery and lock funds for arbiter review");

export const EscrowStatusSchema = z
  .object({
    escrow_id: z.string().describe("The escrow ID to check"),
  })
  .strip()
  .describe("Check the current state of an escrow");

export const TrustScoreSchema = z
  .object({
    address: z.string().describe("Ethereum address to look up"),
  })
  .strip()
  .describe("Look up on-chain trust score of an agent");

export const ProtectedCallSchema = z
  .object({
    url: z.string().url().describe("The API endpoint URL to call"),
    method: z
      .enum(["GET", "POST", "PUT", "DELETE"])
      .default("GET")
      .describe("HTTP method"),
    headers: z
      .record(z.string())
      .optional()
      .describe("HTTP headers to include"),
    body: z.string().optional().describe("Request body (for POST/PUT)"),
    seller_address: z
      .string()
      .describe("Ethereum address of the API provider who will receive payment"),
    amount_usdc: z
      .number()
      .min(0.1)
      .max(100)
      .describe("Amount to pay in USDC"),
    timelock_minutes: z
      .number()
      .min(5)
      .max(43200)
      .default(30)
      .describe("Minutes until escrow expires"),
    verification_schema: z
      .string()
      .describe(
        "JSON Schema string to validate the API response against. If response doesn't match, escrow is auto-disputed."
      ),
  })
  .strip()
  .describe(
    "Make an API call with automatic escrow protection. Creates escrow, calls API, verifies response, auto-releases or disputes."
  );
