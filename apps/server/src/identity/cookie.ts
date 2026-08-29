import { createHash, randomBytes } from "node:crypto";

export const COOKIE_NAME = "steam_top_identity";
export const IDENTITY_COOKIE_LIFETIME_MS = 180 * 24 * 60 * 60 * 1_000;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function issueIdentityToken(): string {
  return randomBytes(32).toString("base64url");
}

export function isIdentityToken(value: unknown): value is string {
  return typeof value === "string" && TOKEN_PATTERN.test(value);
}

export function hashIdentityToken(token: string): string {
  if (!isIdentityToken(token)) throw new TypeError("INVALID_IDENTITY_TOKEN");
  return createHash("sha256").update(token, "ascii").digest("hex");
}

export function serializeIdentityCookie(token: string, now: Date, secure: boolean, lifetimeMs = IDENTITY_COOKIE_LIFETIME_MS): string {
  if (!isIdentityToken(token)) throw new TypeError("INVALID_IDENTITY_TOKEN");
  const maxAge = Math.floor(lifetimeMs / 1_000);
  const parts = [
    `${COOKIE_NAME}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${maxAge}`,
    `Expires=${new Date(now.getTime() + maxAge * 1_000).toUTCString()}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function clearIdentityCookie(secure: boolean): string {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT${secure ? "; Secure" : ""}`;
}
