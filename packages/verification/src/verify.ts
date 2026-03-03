import type { VerificationResult, VerificationStrategy } from "@agora402/core";
import { HashLockVerifier } from "./strategies/hash-lock.js";
import { SchemaVerifier } from "./strategies/schema.js";

export interface Verifier {
  strategy: VerificationStrategy;
  verify(response: unknown, expected: unknown): VerificationResult;
}

const verifiers: Record<VerificationStrategy, Verifier> = {
  "hash-lock": new HashLockVerifier(),
  schema: new SchemaVerifier(),
};

export function verify(
  strategy: VerificationStrategy,
  response: unknown,
  expected: unknown
): VerificationResult {
  const verifier = verifiers[strategy];
  return verifier.verify(response, expected);
}
