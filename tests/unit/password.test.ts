import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "../../src/server/modules/auth/password.js";
import { redactDetails } from "../../src/server/modules/system/activity.js";

describe("Password hashing & audit redaction", () => {
  it("hashes passwords with unique salts and verifies correctly", async () => {
    const hash1 = await hashPassword("SuperSecret123!");
    const hash2 = await hashPassword("SuperSecret123!");

    expect(hash1).not.toBe(hash2);
    expect(hash1.startsWith("scrypt$")).toBe(true);
    expect(await verifyPassword("SuperSecret123!", hash1)).toBe(true);
    expect(await verifyPassword("WrongPassword123!", hash1)).toBe(false);
  });

  it("recursively redacts sensitive fields before storing audit events", () => {
    const redacted = redactDetails({
      username: "admin",
      password: "plaintext-password",
      nested: {
        secretAccessKey: "aws-secret",
        signed_url: "https://example.com?sig=abc",
        safeField: "keep-me"
      }
    });

    expect(redacted).toEqual({
      username: "admin",
      password: "[REDACTED]",
      nested: {
        secretAccessKey: "[REDACTED]",
        signed_url: "[REDACTED]",
        safeField: "keep-me"
      }
    });
  });
});
