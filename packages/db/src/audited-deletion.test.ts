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
      return 3;
    });
    const auditId = await withAuditedDeletion(
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
    expect(auditId).toBe("10000000-0000-4000-8000-000000000001");
    expect(calls).toEqual([
      expect.stringContaining("insert into deletion_audit"),
      expect.stringContaining("set_config('steam_top.deletion_audit_id'"),
      "DELETE_CALLBACK",
    ]);
  });
});
