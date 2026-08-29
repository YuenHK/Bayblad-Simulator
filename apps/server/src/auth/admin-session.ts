import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const ADMIN_COOKIE_NAME = "steam_top_admin";
export const ADMIN_IDLE_MS = 30 * 60_000;
export const ADMIN_ABSOLUTE_MS = 8 * 60 * 60_000;

export const opaqueToken = (): string => randomBytes(32).toString("base64url");
export const tokenHash = (token: string): string => createHash("sha256").update(token, "utf8").digest("hex");
export const csrfForSession = (secret: Buffer, token: string): string => createHmac("sha256", secret).update(token, "utf8").digest("base64url");
export const constantTokenEqual = (left: string, right: string): boolean => {
  const a = Buffer.from(left); const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};
