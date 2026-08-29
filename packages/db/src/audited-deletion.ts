import { z } from "zod";
import type { TransactionSql } from "postgres";

const auditedDeletionSchema = z.object({
  auditId: z.uuid(),
  adminUserId: z.uuid(),
  scope: z.enum(["identity", "class", "date_range", "all"]),
  filterHash: z.string().regex(/^[a-f0-9]{64}$/),
  previewCount: z.number().int().nonnegative(),
  deletedIdentityCount: z.number().int().nonnegative(),
  deletedDesignCount: z.number().int().nonnegative(),
  deletedMatchCount: z.number().int().nonnegative(),
}).strict();

const deletionCountsSchema = z.object({
  deletedIdentityCount: z.number().int().nonnegative(),
  deletedDesignCount: z.number().int().nonnegative(),
  deletedMatchCount: z.number().int().nonnegative(),
}).strict();

export type DeletionCounts = z.infer<typeof deletionCountsSchema>;

export type AuditedDeletionInput = z.input<typeof auditedDeletionSchema>;

export type AuditedDeletionTransaction = Pick<TransactionSql, "unsafe">;

/** Must be called inside one database transaction; rollback preserves all-or-nothing semantics. */
export async function withAuditedDeletion(
  transaction: AuditedDeletionTransaction,
  input: AuditedDeletionInput,
  deleteOperation: () => Promise<DeletionCounts>,
): Promise<Readonly<{ auditId: string; counts: DeletionCounts }>> {
  const parsed = auditedDeletionSchema.parse(input);
  await transaction.unsafe(
    `insert into deletion_audit (
      id, admin_user_id, scope, filter_hash, preview_count,
      deleted_identity_count, deleted_design_count, deleted_match_count
    ) values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [parsed.auditId, parsed.adminUserId, parsed.scope, parsed.filterHash,
      parsed.previewCount, parsed.deletedIdentityCount, parsed.deletedDesignCount,
      parsed.deletedMatchCount],
  );
  await transaction.unsafe(
    "select set_config('steam_top.deletion_audit_id', $1, true)",
    [parsed.auditId],
  );
  try {
    const counts = deletionCountsSchema.parse(await deleteOperation());
    if (
      counts.deletedIdentityCount !== parsed.deletedIdentityCount ||
      counts.deletedDesignCount !== parsed.deletedDesignCount ||
      counts.deletedMatchCount !== parsed.deletedMatchCount
    ) {
      throw new Error("Actual deletion counts do not match the deletion audit");
    }
    return Object.freeze({ auditId: parsed.auditId, counts: Object.freeze(counts) });
  } finally {
    await transaction.unsafe(
      "select set_config('steam_top.deletion_audit_id', '', true)",
    );
  }
}
