import crypto from "node:crypto";

export function verifyAccessCode(inputCode: string, expectedCode: string): boolean {
  const inputDigest = crypto.createHash("sha256").update(inputCode).digest();
  const expectedDigest = crypto.createHash("sha256").update(expectedCode).digest();
  return crypto.timingSafeEqual(inputDigest, expectedDigest);
}

export function generateSessionToken(accessCode: string): { rawToken: string; tokenHash: string } {
  const rawToken = crypto.randomBytes(32).toString("base64url");
  const tokenHash = hashSessionToken(rawToken, accessCode);
  return { rawToken, tokenHash };
}

export function hashSessionToken(rawToken: string, accessCode: string): string {
  return crypto.createHmac("sha256", accessCode).update(rawToken).digest("hex");
}
