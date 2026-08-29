import { describe, expect, it, vi } from "vitest";

import {
  type AuditedDeletionTransaction,
  withAuditedDeletion,
} from "./audited-deletion";

describe("audited deletion transaction helper", () => {
  it("inserts an immutable audit row before setting its local id and deleting", async () => {
    const calls: string[] = [];
    const unsafe = vi.fn(async (sql: string) => {
      calls.push(sql);
      return [];
    });
    const deleted = vi.fn(async () => {
      calls.push("DELETE_CALLBACK");
      return { deletedIdentityCount: 1, deletedDesignCount: 1, deletedMatchCount: 1 };
    });
    const result = await withAuditedDeletion(
      { unsafe } as unknown as AuditedDeletionTransaction,
      {
        auditId: "10000000-0000-4000-8000-000000000001",
        adminUserId: "20000000-0000-4000-8000-000000000001",
        scope: "identity",
        filterHash: "a".repeat(64),
        previewCount: 3,
        deletedIdentityCount: 1,
        deletedDesignCount: 1,
        deletedMatchCount: 1,
      },
      deleted,
    );
    expect(result).toEqual({
      auditId: "10000000-0000-4000-8000-000000000001",
      counts: { deletedIdentityCount: 1, deletedDesignCount: 1, deletedMatchCount: 1 },
    });
    expect(calls).toEqual([
      expect.stringContaining("insert into deletion_audit"),
      expect.stringContaining("set_config('steam_top.deletion_audit_id'"),
      "DELETE_CALLBACK",
      expect.stringContaining("set_config('steam_top.deletion_audit_id', ''"),
    ]);
  });

  it("rejects mismatched actual counts and always clears the local grant", async () => {
    const calls: string[] = [];
    const unsafe = vi.fn(async (sql: string) => { calls.push(sql); return []; });
    await expect(withAuditedDeletion(
      { unsafe } as unknown as AuditedDeletionTransaction,
      {
        auditId: "10000000-0000-4000-8000-000000000001",
        adminUserId: "20000000-0000-4000-8000-000000000001",
        scope: "all", filterHash: "a".repeat(64), previewCount: 1,
        deletedIdentityCount: 0, deletedDesignCount: 0, deletedMatchCount: 1,
      },
      async () => ({ deletedIdentityCount: 0, deletedDesignCount: 0, deletedMatchCount: 0 }),
    )).rejects.toThrow("Actual deletion counts do not match");
    expect(calls.at(-1)).toContain("set_config('steam_top.deletion_audit_id', ''");
  });

  it("clears the local grant when the controlled delete throws", async () => {
    const calls: string[] = [];
    const unsafe = vi.fn(async (sql: string) => { calls.push(sql); return []; });
    await expect(withAuditedDeletion(
      { unsafe } as unknown as AuditedDeletionTransaction,
      {
        auditId: "10000000-0000-4000-8000-000000000001",
        adminUserId: "20000000-0000-4000-8000-000000000001",
        scope: "all", filterHash: "a".repeat(64), previewCount: 1,
        deletedIdentityCount: 0, deletedDesignCount: 0, deletedMatchCount: 1,
      },
      async () => { throw new Error("delete failed"); },
    )).rejects.toThrow("delete failed");
    expect(calls.at(-1)).toContain("set_config('steam_top.deletion_audit_id', ''");
  });
});
