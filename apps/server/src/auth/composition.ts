import type { DatabaseClient } from "@steam-top/db";
import { AdminAuthService } from "./admin-auth";
import { PostgresAdminStore } from "./postgres-admin-store";

function required(env: NodeJS.ProcessEnv, name: string): string { const value = env[name]?.trim(); if (!value) throw new Error(`MISSING_${name}`); return value; }
export async function createAdminComposition(env: NodeJS.ProcessEnv, db: DatabaseClient["db"], allowedOrigins: readonly string[]): Promise<AdminAuthService> {
  const service = new AdminAuthService(new PostgresAdminStore(db), { allowedOrigins, secureCookies: true });
  await service.bootstrap(required(env, "ADMIN_USERNAME"), required(env, "ADMIN_INITIAL_PASSWORD"));
  return service;
}
