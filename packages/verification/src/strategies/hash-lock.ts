import { createHash } from "node:crypto";
import type { VerificationResult } from "@agora402/core";
import type { Verifier } from "../verify.js";

export class HashLockVerifier implements Verifier {
  strategy = "hash-lock" as const;

  verify(response: unknown, expected: unknown): VerificationResult {
    const responseStr =
      typeof response === "string" ? response : JSON.stringify(response);

    const responseHash = createHash("sha256")
      .update(responseStr)
      .digest("hex");

    if (typeof expected !== "string") {
      return {
        valid: false,
        strategy: this.strategy,
        details: "Expected value must be a hex hash string",
      };
    }

    const valid = responseHash === expected;

    return {
      valid,
      strategy: this.strategy,
      details: valid
        ? "Response hash matches expected"
        : `Hash mismatch: got ${responseHash}, expected ${expected}`,
    };
  }
}
