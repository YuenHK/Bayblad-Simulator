import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createDatabaseClient, type DatabaseClient } from "@steam-top/db";
import { PostgresAdminCommandStore, adminCommandPayloadHash } from "./command-operations";
import { postgresTestSchemaUrl } from "../postgres-test-url";

const databaseUrl=process.env.TEST_DATABASE_URL,schemaName=`commands_${randomUUID().replaceAll("-","")}`;let client:DatabaseClient;
beforeAll(async()=>{if(!databaseUrl)return;const local=/(?:localhost|127\.0\.0\.1)/u.test(databaseUrl);client=createDatabaseClient({url:postgresTestSchemaUrl(databaseUrl,schemaName),ssl:local?false:"require",allowInsecure:local,maxConnections:10});await client.sql.unsafe(`create schema ${schemaName}`);await client.sql.unsafe(`set search_path to ${schemaName},public`);const directory=fileURLToPath(new URL("../../../../drizzle",import.meta.url));for(const file of readdirSync(directory).filter(name=>name.endsWith(".sql")).sort())for(const statement of readFileSync(`${directory}/${file}`,"utf8").split("--> statement-breakpoint").map(value=>value.trim()).filter(Boolean))if(!statement.includes('"restore_control"'))await client.sql.unsafe(statement);},30_000);
afterAll(async()=>{if(!client)return;await client.sql.unsafe("set search_path to public");await client.sql.unsafe(`drop schema ${schemaName} cascade`);await client.close();});

it.skipIf(!databaseUrl)("fences two workers across claim renewal expiry progress completion and pruning",async()=>{
  const first=new PostgresAdminCommandStore(client),second=new PostgresAdminCommandStore(client),now=new Date("2026-08-29T00:00:00Z"),operationId=randomUUID();
  await first.accept({operationId,payloadHash:adminCommandPayloadHash({action:"room.close",roomId:"ROOM"}),action:"room.close",target:"ROOM",payload:{action:"room.close",roomId:"ROOM"},adminUserId:randomUUID(),adminSessionId:randomUUID()},now);
  const claims=await Promise.all([first.claimDue(now,1_000),second.claimDue(now,1_000)]),claimed=claims.find(Boolean)!;
  expect(claims.filter(Boolean)).toHaveLength(1);
  expect(await first.renewLease(operationId,claimed.leaseToken!,claimed.leaseGeneration+1,now,1_000)).toBe(false);
  expect(await first.renewLease(operationId,claimed.leaseToken!,claimed.leaseGeneration,now,1_000)).toBe(true);
  expect(await first.progress(operationId,claimed.leaseToken!,claimed.leaseGeneration,{status:"pending",step:"participant_left"},now)).toBe(true);
  expect((await second.get(operationId))?.result.step).toBe("participant_left");
  const takeover=await second.claimDue(new Date(now.getTime()+1_001),1_000);expect(takeover?.leaseGeneration).toBe(claimed.leaseGeneration+1);
  expect(await first.progress(operationId,claimed.leaseToken!,claimed.leaseGeneration,{step:"stale"},now)).toBe(false);
  await expect(first.checkpoint(operationId,claimed.leaseToken!,"completed")).rejects.toThrow("ADMIN_COMMAND_LEASE_LOST");
  await second.checkpoint(operationId,takeover!.leaseToken!,"completed",{status:"completed"});
  await client.sql.unsafe("update admin_command_operations set updated_at='2026-08-01T00:00:00Z' where operation_id=$1",[operationId]);
  expect(await first.pruneTerminal(new Date("2026-08-29T00:00:00Z"),100)).toBe(1);expect(await first.get(operationId)).toBeNull();
},30_000);
