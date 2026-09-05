import { expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { PostgresMatchRepository } from "./match-repository";
import { PostgresRoomProjectionStore } from "./room-projection-store";

it("serializes raw retention cutoffs before postgres-js timestamp encoding", async () => {
  const queries: SQL[] = [];
  const db = {
    execute: async (query: SQL) => { queries.push(query); return []; },
    update: () => ({ set: () => ({ where: async () => [] }) }),
  } as unknown as ConstructorParameters<typeof PostgresMatchRepository>[0];
  const now = new Date("2026-09-05T00:00:00Z");
  await new PostgresMatchRepository(db).pruneRetention(now);
  await new PostgresRoomProjectionStore(db).pruneDead(now);
  expect(queries).toHaveLength(2);
  const dialect = new PgDialect();
  for (const query of queries) {
    const compiled = dialect.sqlToQuery(query);
    expect(compiled.params.some(value => value instanceof Date)).toBe(false);
    expect(compiled.params[0]).toMatch(/^2026-\d\d-\d\dT/);
    expect(compiled.sql).toContain("::timestamptz");
  }
});
