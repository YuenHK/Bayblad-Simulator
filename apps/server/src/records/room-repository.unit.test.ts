import { expect, it } from "vitest";
import { createDatabaseClient } from "@steam-top/db";
import { rooms } from "@steam-top/db/schema";
import { eq } from "drizzle-orm";
import { coalesceTimestamp } from "./room-repository";

it("encodes coalesced room timestamps using the timestamp column type", () => {
  const client = createDatabaseClient({ url: "postgres://test:test@127.0.0.1:5432/test", ssl: false, allowInsecure: true });
  const value = new Date("2026-08-31T05:32:05.810Z");
  const query = client.db.update(rooms).set({ firstBattleAt: coalesceTimestamp(rooms.firstBattleAt, value) }).where(eq(rooms.id, "11111111-1111-4111-8111-111111111111")).toSQL();

  expect(query.params[0]).toBe(value.toISOString());
  expect(query.params[0]).not.toBeInstanceOf(Date);
});
