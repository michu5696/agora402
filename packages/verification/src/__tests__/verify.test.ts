import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { verify } from "../verify.js";
import { SchemaVerifier } from "../strategies/schema.js";
import { HashLockVerifier } from "../strategies/hash-lock.js";

// ── SchemaVerifier ──────────────────────────────────────────────────

describe("SchemaVerifier", () => {
  const verifier = new SchemaVerifier();

  it("returns valid=true when response matches JSON Schema", () => {
    const schema = {
      type: "object",
      properties: {
        name: { type: "string" },
        age: { type: "number" },
      },
      required: ["name"],
    };

    const result = verifier.verify({ name: "Alice", age: 30 }, schema);

    expect(result.valid).toBe(true);
    expect(result.strategy).toBe("schema");
    expect(result.details).toBe("Response matches JSON Schema");
  });

  it("returns valid=false with error details when required field is missing", () => {
    const schema = {
      type: "object",
      properties: {
        name: { type: "string" },
        email: { type: "string" },
      },
      required: ["name", "email"],
    };

    const result = verifier.verify({ name: "Alice" }, schema);

    expect(result.valid).toBe(false);
    expect(result.strategy).toBe("schema");
    expect(result.details).toContain("Schema validation failed");
    expect(result.details).toContain("email");
  });

  it("returns valid=false when expected is not an object", () => {
    const result = verifier.verify({ data: 1 }, "not-a-schema");

    expect(result.valid).toBe(false);
    expect(result.details).toBe("Expected value must be a JSON Schema object");
  });

  it("returns valid=false when expected is null", () => {
    const result = verifier.verify({ data: 1 }, null);

    expect(result.valid).toBe(false);
    expect(result.details).toBe("Expected value must be a JSON Schema object");
  });

  it("validates complex nested schemas", () => {
    const schema = {
      type: "object",
      properties: {
        user: {
          type: "object",
          properties: {
            name: { type: "string" },
            address: {
              type: "object",
              properties: {
                city: { type: "string" },
                zip: { type: "string", pattern: "^\\d{5}$" },
              },
              required: ["city", "zip"],
            },
          },
          required: ["name", "address"],
        },
      },
      required: ["user"],
    };

    // Valid nested
    const valid = verifier.verify(
      {
        user: {
          name: "Alice",
          address: { city: "NYC", zip: "10001" },
        },
      },
      schema,
    );
    expect(valid.valid).toBe(true);

    // Invalid: wrong zip pattern
    const invalid = verifier.verify(
      {
        user: {
          name: "Alice",
          address: { city: "NYC", zip: "bad" },
        },
      },
      schema,
    );
    expect(invalid.valid).toBe(false);
    expect(invalid.details).toContain("Schema validation failed");
  });
});

// ── HashLockVerifier ────────────────────────────────────────────────

describe("HashLockVerifier", () => {
  const verifier = new HashLockVerifier();

  function sha256(input: string): string {
    return createHash("sha256").update(input).digest("hex");
  }

  it("returns valid=true when hash matches", () => {
    const data = "hello world";
    const hash = sha256(data);

    const result = verifier.verify(data, hash);

    expect(result.valid).toBe(true);
    expect(result.strategy).toBe("hash-lock");
    expect(result.details).toBe("Response hash matches expected");
  });

  it("returns valid=false with both hashes when hash does not match", () => {
    const data = "hello world";
    const wrongHash = sha256("wrong data");

    const result = verifier.verify(data, wrongHash);

    expect(result.valid).toBe(false);
    expect(result.strategy).toBe("hash-lock");
    expect(result.details).toContain("Hash mismatch");
    expect(result.details).toContain(sha256(data));
    expect(result.details).toContain(wrongHash);
  });

  it("returns valid=false when expected is not a string", () => {
    const result = verifier.verify("some data", 12345);

    expect(result.valid).toBe(false);
    expect(result.details).toBe("Expected value must be a hex hash string");
  });

  it("stringifies JSON object responses before hashing", () => {
    const obj = { key: "value", num: 42 };
    const expectedHash = sha256(JSON.stringify(obj));

    const result = verifier.verify(obj, expectedHash);

    expect(result.valid).toBe(true);
    expect(result.details).toBe("Response hash matches expected");
  });
});

// ── verify() dispatcher ─────────────────────────────────────────────

describe("verify()", () => {
  it("dispatches to schema strategy", () => {
    const schema = {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    };

    const result = verify("schema", { name: "Alice" }, schema);
    expect(result.valid).toBe(true);
    expect(result.strategy).toBe("schema");
  });

  it("dispatches to hash-lock strategy", () => {
    const data = "test-data";
    const hash = createHash("sha256").update(data).digest("hex");

    const result = verify("hash-lock", data, hash);
    expect(result.valid).toBe(true);
    expect(result.strategy).toBe("hash-lock");
  });

  it("returns invalid from schema when response does not match", () => {
    const schema = {
      type: "object",
      properties: { count: { type: "number" } },
      required: ["count"],
    };

    const result = verify("schema", { count: "not-a-number" }, schema);
    expect(result.valid).toBe(false);
    expect(result.strategy).toBe("schema");
  });

  it("returns invalid from hash-lock when hashes differ", () => {
    const result = verify("hash-lock", "abc", "0000");
    expect(result.valid).toBe(false);
    expect(result.strategy).toBe("hash-lock");
  });
});
