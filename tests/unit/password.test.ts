import { describe, expect, it } from "vitest";
import {
  generateSessionToken,
  hashSessionToken,
  verifyAccessCode
} from "../../src/server/modules/auth/password.js";
import { redactDetails } from "../../src/server/modules/system/activity.js";

describe("Access code verification, session tokens & audit redaction", () => {
  it("verifies access codes accurately and ties session token hashes to the active access code", () => {
    expect(verifyAccessCode("Nest-2026!", "Nest-2026!")).toBe(true);
    expect(verifyAccessCode("wrong", "Nest-2026!")).toBe(false);
    expect(verifyAccessCode("Nest-2026", "Nest-2026!")).toBe(false);

    const { rawToken, tokenHash } = generateSessionToken("Nest-2026!");
    expect(hashSessionToken(rawToken, "Nest-2026!")).toBe(tokenHash);
    expect(hashSessionToken(rawToken, "Rotated-Code!")).not.toBe(tokenHash);
  });

  it("recursively redacts sensitive fields before storing audit events", () => {
    const redacted = redactDetails({
      accessCode: "secret-access-code",
      password: "plaintext-password",
      nested: {
        secretAccessKey: "aws-secret",
        signed_url: "https://example.com?sig=abc",
        safeField: "keep-me"
      }
    });

    expect(redacted).toEqual({
      accessCode: "[REDACTED]",
      password: "[REDACTED]",
      nested: {
        secretAccessKey: "[REDACTED]",
        signed_url: "[REDACTED]",
        safeField: "keep-me"
      }
    });
  });
});
