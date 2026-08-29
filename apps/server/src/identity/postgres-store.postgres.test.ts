import { readFileSync, readdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createDatabaseClient, type DatabaseClient } from "@steam-top/db";
import { createValidatedLiveIdentityProvider, IdentityResolver } from "./resolver";
import { hashIdentityToken } from "./cookie";
import { PostgresIdentityStore } from "./postgres-store";

const databaseUrl = process.env.TEST_DATABASE_URL;
const schemaName = `identity_${randomUUID().replaceAll("-", "")}`;
let client: DatabaseClient;

beforeAll(async () => {
  if (!databaseUrl) return;
  const local = /(?:localhost|127\.0\.0\.1)/u.test(databaseUrl);
  client = createDatabaseClient({ url: databaseUrl, ssl: local ? false : "require", allowInsecure: local, maxConnections: 1 });
  await client.sql.unsafe(`create schema ${schemaName}`);
  await client.sql.unsafe(`set search_path to ${schemaName},public`);
  const directory = fileURLToPath(new URL("../../../../drizzle", import.meta.url));
  for (const file of readdirSync(directory).filter((name) => name.endsWith(".sql")).sort()) {
    for (const statement of readFileSync(`${directory}/${file}`, "utf8").split("--> statement-breakpoint").map((value) => value.trim()).filter(Boolean)) await client.sql.unsafe(statement);
  }
}, 30_000);

afterAll(async () => {
  if (!client) return;
  await client.sql.unsafe("set search_path to public");
  await client.sql.unsafe(`drop schema ${schemaName} cascade`);
  await client.close();
});

it.skipIf(!databaseUrl)("allows duplicate guest labels and atomically upgrades concurrent live identity", async () => {
  const store = new PostgresIdentityStore(client.db, { maxIdentities: 100, maxSessions: 200 });
  const now = new Date("2026-08-29T00:00:00Z");
  const expiresAt = new Date(now.getTime() + 86_400_000);
  const a = await store.createGuestSession({ tokenHash: hashIdentityToken("E".repeat(43)), displayName: "訪客-AAAA", now, expiresAt, diagnostics: {} });
  const b = await store.createGuestSession({ tokenHash: hashIdentityToken("F".repeat(43)), displayName: "訪客-AAAA", now, expiresAt, diagnostics: {} });
  expect(a.identity.id).not.toBe(b.identity.id);

  const resolver = new IdentityResolver(store, { now: () => now });
  const guest = await resolver.resolve({});
  const live = await createValidatedLiveIdentityProvider({ resolve: async () => ({ externalId: "ipad-concurrent", displayName: "1A 07", studentName: "陳同學", className: "1A", studentNumber: "07" }) }).resolve();
  const upgraded = await Promise.all(Array.from({ length: 5 }, () => resolver.resolve({ cookieToken: guest.cookieToken }, live!)));
  expect(new Set(upgraded.map((item) => item.identity.id)).size).toBe(1);
  expect(await store.findSession(hashIdentityToken(guest.cookieToken), now)).toBeNull();
});

it.skipIf(!databaseUrl)("never revives a token during a logout and lookup race", async () => {
  const now = new Date("2026-08-29T00:00:00Z");
  const store = new PostgresIdentityStore(client.db, { maxIdentities: 100, maxSessions: 200 });
  const resolver = new IdentityResolver(store, { now: () => now });
  const issued = await resolver.resolve({});
  await Promise.allSettled([resolver.resolve({ cookieToken: issued.cookieToken }), resolver.revoke(issued.cookieToken)]);
  expect(await store.findSession(hashIdentityToken(issued.cookieToken), now)).toBeNull();
});
