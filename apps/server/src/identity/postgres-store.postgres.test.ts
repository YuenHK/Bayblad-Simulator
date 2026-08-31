import { readFileSync, readdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createDatabaseClient, type DatabaseClient } from "@steam-top/db";
import { deviceActivityDays, identities, identityLinks, identitySessions } from "@steam-top/db/schema";
import { and, count, eq, gt, isNull } from "drizzle-orm";
import { createValidatedLiveIdentityProvider, IdentityResolver } from "./resolver";
import { hashIdentityToken } from "./cookie";
import { PostgresIdentityStore } from "./postgres-store";
import { PostgresTokenNonceStore } from "./postgres-token-nonce";
import { postgresTestSchemaUrl } from "../postgres-test-url";

const databaseUrl = process.env.TEST_DATABASE_URL;
const schemaName = `identity_${randomUUID().replaceAll("-", "")}`;
let client: DatabaseClient;

beforeAll(async () => {
  if (!databaseUrl) return;
  const local = /(?:localhost|127\.0\.0\.1)/u.test(databaseUrl);
  client = createDatabaseClient({ url: postgresTestSchemaUrl(databaseUrl, schemaName), ssl: local ? false : "require", allowInsecure: local, maxConnections: 10 });
  await client.sql.unsafe(`create schema ${schemaName}`);
  await client.sql.unsafe(`set search_path to ${schemaName},public`);
  const directory = fileURLToPath(new URL("../../../../drizzle", import.meta.url));
  for (const file of readdirSync(directory).filter((name) => name.endsWith(".sql")).sort()) {
    for (const statement of readFileSync(`${directory}/${file}`, "utf8").split("--> statement-breakpoint").map((value) => value.trim()).filter(Boolean)) if(!statement.includes('"restore_control"'))await client.sql.unsafe(statement);
  }
}, 30_000);

afterAll(async () => {
  if (!client) return;
  await client.sql.unsafe("set search_path to public");
  await client.sql.unsafe(`drop schema ${schemaName} cascade`);
  await client.close();
});

it.skipIf(!databaseUrl)("atomically exchanges a durable Web Clip nonce and recovers the same attempt", async () => {
  const store = new PostgresTokenNonceStore(client.db);
  const issuedAt = new Date("2026-08-29T00:00:00Z"); const expiresAt = new Date("2026-08-29T00:05:00Z");
  const jtiHash = "a".repeat(64);
  await store.issue({ jtiHash, deviceId: "ipad-atomic", issuedAt, expiresAt });
  const now = new Date("2026-08-29T00:01:00Z"), attemptHash="b".repeat(64);
  expect(await store.preflight(jtiHash,attemptHash,now)).toEqual({status:"unused"});
  const identityStore=new PostgresIdentityStore(client.db); const persisted=await identityStore.createGuestSession({tokenHash:"c".repeat(64),displayName:"nonce-test",now,expiresAt:new Date(now.getTime()+86_400_000),diagnostics:{}});
  const created={identityId:persisted.identity.id,sessionId:persisted.id,tokenHash:persisted.tokenHash,committedAt:now};
  expect(await store.exchange({jtiHash,attemptHash,now},async()=>created)).toMatchObject({status:"committed"});
  expect(await store.preflight(jtiHash,attemptHash,now)).toMatchObject({status:"recovered",result:{sessionId:persisted.id}});
  expect(await store.preflight(jtiHash,"d".repeat(64),now)).toEqual({status:"replay"});
  expect(await store.exchange({jtiHash,attemptHash,now},async()=>{throw new Error("must not run");})).toMatchObject({status:"recovered"});
  expect(await store.exchange({jtiHash,attemptHash:"d".repeat(64),now},async()=>created)).toEqual({status:"replay"});
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
  let arrived = 0; let release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const attempts = Array.from({ length: 5 }, async () => { arrived += 1; await barrier; return resolver.resolve({ cookieToken: guest.cookieToken }, live!); });
  while (arrived < 5) await Promise.resolve();
  release();
  const upgraded = await Promise.all(attempts);
  expect(new Set(upgraded.map((item) => item.identity.id)).size).toBe(1);
  expect(new Set(upgraded.map((item) => item.cookieToken)).size).toBe(1);
  expect(await store.findSession(hashIdentityToken(guest.cookieToken), now)).toBeNull();
  const [identityCount] = await client.db.select({ value: count() }).from(identities);
  const [linkCount] = await client.db.select({ value: count() }).from(identityLinks);
  const [activeCount] = await client.db.select({ value: count() }).from(identitySessions).where(and(isNull(identitySessions.revokedAt), gt(identitySessions.expiresAt, now)));
  expect(identityCount!.value).toBe(4);
  expect(linkCount!.value).toBe(1);
  expect(activeCount!.value).toBe(3);
  const [upgradedIdentity]=await client.db.select().from(identities).where(eq(identities.id,upgraded[0]!.identity.id));
  const [sameDay]=await client.db.select().from(deviceActivityDays).where(eq(deviceActivityDays.anonymousDeviceId,upgradedIdentity!.anonymousDeviceId));
  expect(sameDay).toMatchObject({identityStatusSnapshot:"iclass",classNameSnapshot:"1A"});
});

it.skipIf(!databaseUrl)("never revives a token during a logout and lookup race", async () => {
  const now = new Date("2026-08-29T00:00:00Z");
  const store = new PostgresIdentityStore(client.db, { maxIdentities: 100, maxSessions: 200 });
  const resolver = new IdentityResolver(store, { now: () => now });
  const issued = await resolver.resolve({});
  await Promise.allSettled([resolver.resolve({ cookieToken: issued.cookieToken }), resolver.revoke(issued.cookieToken)]);
  expect(await store.findSession(hashIdentityToken(issued.cookieToken), now)).toBeNull();
  const archived = await resolver.resolve({});
  await resolver.revoke(archived.cookieToken);
  const [row] = await client.db.select().from(identitySessions).where(eq(identitySessions.tokenHash, hashIdentityToken(archived.cookieToken))).limit(1);
  expect(row?.revokedAt).toEqual(now);
  expect(row?.archivedAt).toEqual(now);
});

it.skipIf(!databaseUrl)("persists immutable Hong Kong device activity days instead of moving last-seen DAU", async()=>{
  const store=new PostgresIdentityStore(client.db); const first=new Date("2026-08-31T15:59:59Z"); const token="9".repeat(64);
  const session=await store.createGuestSession({tokenHash:token,displayName:"訪客-DAY",now:first,expiresAt:new Date("2027-01-01T00:00:00Z"),diagnostics:{}});
  await store.recordActivity(token,new Date("2026-08-31T15:59:59.500Z"));
  await store.touchSession(token,new Date("2026-08-31T16:00:01Z"),{},new Date("2027-01-02T00:00:00Z"));
  const rows=await client.db.select().from(deviceActivityDays).where(eq(deviceActivityDays.identityId,session.identity.id));
  expect(rows.map(row=>row.activityDate).sort()).toEqual(["2026-08-31","2026-09-01"]);
  expect(rows.find(row=>row.activityDate==="2026-08-31")?.lastActivityAt).toEqual(first);
},30_000);

it.skipIf(!databaseUrl)("counts only active sessions and rotates one-for-one at capacity with rollback safety", async () => {
  const now = new Date("2026-08-29T00:00:00Z");
  const [baseline] = await client.db.select({ value: count() }).from(identitySessions).where(and(isNull(identitySessions.revokedAt), gt(identitySessions.expiresAt, now)));
  const limit = baseline!.value + 1;
  const store = new PostgresIdentityStore(client.db, { maxIdentities: 1_000, maxSessions: limit });
  for (let index = 0; index < 20; index += 1) await store.createGuestSession({ tokenHash: hashIdentityToken(`${index}`.padStart(43, "G").replaceAll(/[^A-Za-z0-9_-]/gu, "G")), displayName: "訪客-OLD", now, expiresAt: new Date(now.getTime() - 1), diagnostics: {} });
  const active = await store.createGuestSession({ tokenHash: hashIdentityToken("H".repeat(43)), displayName: "訪客-CAP", now, expiresAt: new Date(now.getTime() + 86_400_000), diagnostics: {} });
  await expect(store.createGuestSession({ tokenHash: hashIdentityToken("I".repeat(43)), displayName: "訪客-FULL", now, expiresAt: new Date(now.getTime() + 86_400_000), diagnostics: {} })).rejects.toThrow("IDENTITY_CAPACITY_REACHED");
  const live = await createValidatedLiveIdentityProvider({ resolve: async () => ({ externalId: "ipad-cap", displayName: "1A 08", studentName: "何同學", className: "1A", studentNumber: "08" }) }).resolve();
  const rotatedHash = hashIdentityToken("J".repeat(43));
  await store.upsertLiveSession({ tokenHash: rotatedHash, previousTokenHash: active.tokenHash, identity: live!, now, expiresAt: new Date(now.getTime() + 86_400_000), diagnostics: {}, cachedIdentityId: active.identity.id });
  await expect(store.upsertLiveSession({ tokenHash: rotatedHash, previousTokenHash: rotatedHash, identity: live!, now, expiresAt: new Date(now.getTime() + 86_400_000), diagnostics: {} })).rejects.toThrow();
  expect(await store.findSession(rotatedHash, now)).not.toBeNull();
});
