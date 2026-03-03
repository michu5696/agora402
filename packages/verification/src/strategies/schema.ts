import Ajv from "ajv";
import type { VerificationResult } from "@agora402/core";
import type { Verifier } from "../verify.js";

const ajv = new Ajv({ allErrors: true });

export class SchemaVerifier implements Verifier {
  strategy = "schema" as const;

  verify(response: unknown, expected: unknown): VerificationResult {
    if (typeof expected !== "object" || expected === null) {
      return {
        valid: false,
        strategy: this.strategy,
        details: "Expected value must be a JSON Schema object",
      };
    }

    const validate = ajv.compile(expected);
    const valid = validate(response);

    if (valid) {
      return {
        valid: true,
        strategy: this.strategy,
        details: "Response matches JSON Schema",
      };
    }

    const errors = validate.errors
      ?.map((e) => `${e.instancePath} ${e.message}`)
      .join("; ");

    return {
      valid: false,
      strategy: this.strategy,
      details: `Schema validation failed: ${errors}`,
    };
  }
}
