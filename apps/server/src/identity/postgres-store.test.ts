import { describe, expect, it } from "vitest";
import { createDatabaseClient } from "@steam-top/db";
import { IdentityCapacityError, SessionTokenUnavailableError } from "./resolver";
import { buildDeviceActivityUpsert, runIdentityStoreStage } from "./postgres-store";

describe("identity store diagnostics", () => {
  it("adds a safe stage code while retaining the original failure", async () => {
    const failure = new Error("private database detail");
    const result = runIdentityStoreStage("IDENTITY_INSERT_FAILED", async () => { throw failure; });

    await expect(result).rejects.toMatchObject({
      name: "IdentityStoreStageError",
      code: "IDENTITY_INSERT_FAILED",
      cause: failure,
    });
  });

  it.each([new IdentityCapacityError(), new SessionTokenUnavailableError()])(
    "does not replace expected domain errors",
    async (failure) => {
      await expect(runIdentityStoreStage("IDENTITY_INSERT_FAILED", async () => { throw failure; })).rejects.toBe(failure);
    },
  );

  it("uses excluded activity values in the conflict predicate instead of untyped parameters", () => {
    const client = createDatabaseClient({ url: "postgres://test:test@127.0.0.1:5432/test", ssl: false, allowInsecure: true });
    const query = buildDeviceActivityUpsert(client.db as never, {
      id: "11111111-1111-4111-8111-111111111111",
      anonymousDeviceId: "22222222-2222-4222-8222-222222222222",
      status: "guest",
      className: null,
    } as never, new Date("2026-08-31T04:00:00Z")).toSQL();

    expect(query.sql).toContain("excluded.last_activity_at");
    expect(query.sql).toContain("excluded.identity_id");
    expect(query.params).toHaveLength(7);
  });
});
