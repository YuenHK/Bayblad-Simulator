import type { DatabaseClient } from "@steam-top/db";
import { AdminAuthService } from "./admin-auth";
import { PostgresAdminStore } from "./postgres-admin-store";

function required(env: NodeJS.ProcessEnv, name: string): string { const value = env[name]?.trim(); if (!value) throw new Error(`MISSING_${name}`); return value; }
export async function createAdminComposition(env: NodeJS.ProcessEnv, db: DatabaseClient["db"], allowedOrigins: readonly string[]): Promise<AdminAuthService> {
  const encodedSecret = required(env, "ADMIN_CSRF_SECRET"); const csrfSecret = Buffer.from(encodedSecret, "base64url");
  if (csrfSecret.length < 32 || csrfSecret.toString("base64url") !== encodedSecret) throw new Error("INVALID_ADMIN_CSRF_SECRET");
  const parsedOrigin = new URL(required(env, "PUBLIC_ORIGIN")); if (process.env.NODE_ENV === "production" && parsedOrigin.protocol !== "https:") throw new Error("ADMIN_PUBLIC_ORIGIN_REQUIRES_HTTPS"); const publicOrigin = parsedOrigin.origin; if (!allowedOrigins.includes(publicOrigin)) throw new Error("ADMIN_PUBLIC_ORIGIN_MISMATCH");
  const service = new AdminAuthService(new PostgresAdminStore(db), { allowedOrigins: [publicOrigin], secureCookies: true, csrfSecret, csrfKeyId: required(env, "ADMIN_CSRF_KEY_ID"), logError: (event) => { try { process.stderr.write(`${JSON.stringify({ level: "error", area: "admin-auth", ...event })}\n`); } catch { /* fail closed without logging secrets */ } } });
  await service.bootstrap(required(env, "ADMIN_USERNAME"), required(env, "ADMIN_INITIAL_PASSWORD"));
  return service;
}
