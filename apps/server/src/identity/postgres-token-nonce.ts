import { and, eq, gt, inArray, lte } from "drizzle-orm";
import { timingSafeEqual } from "node:crypto";
import type { DatabaseClient } from "@steam-top/db";
import { webClipTokenNonces } from "@steam-top/db/schema";
import type { StoredWebClipExchange, TokenNonceStore } from "./webclip-token";

export class PostgresTokenNonceStore implements TokenNonceStore {
  readonly durable = true;
  readonly #db: DatabaseClient["db"];
  constructor(db: DatabaseClient["db"]) { this.#db = db; }
  async issue(input: Readonly<{ jtiHash: string; deviceId: string; issuedAt: Date; expiresAt: Date }>): Promise<void> {
    await this.#db.insert(webClipTokenNonces).values(input);
  }
  async lookup(jtiHash: string, now: Date): Promise<string | null> {
    const [record] = await this.#db.select({ deviceId: webClipTokenNonces.deviceId }).from(webClipTokenNonces).where(and(eq(webClipTokenNonces.jtiHash, jtiHash), gt(webClipTokenNonces.expiresAt, now))).limit(1);
    return record?.deviceId ?? null;
  }
  async exchange<T extends StoredWebClipExchange>(input: Readonly<{ jtiHash: string; attemptHash: string; now: Date }>, create: (transaction?: unknown) => Promise<T>) {
    return this.#db.transaction(async (tx) => {
      const [row] = await tx.select().from(webClipTokenNonces).where(eq(webClipTokenNonces.jtiHash, input.jtiHash)).for("update").limit(1);
      if (!row || row.expiresAt <= input.now) return { status: "missing" as const };
      if (row.usedAt) {
        const a = Buffer.from(row.attemptHash ?? "", "hex"), b = Buffer.from(input.attemptHash, "hex");
        if (a.length !== 32 || b.length !== 32 || !timingSafeEqual(a, b) || !row.resultIdentityId || !row.resultSessionId || !row.resultTokenHash || !row.committedAt) return { status: "replay" as const };
        return { status: "recovered" as const, result: { identityId: row.resultIdentityId, sessionId: row.resultSessionId, tokenHash: row.resultTokenHash, committedAt: row.committedAt } as T };
      }
      const result = await create(tx);
      await tx.update(webClipTokenNonces).set({ usedAt: input.now, attemptHash: input.attemptHash, resultIdentityId: result.identityId, resultSessionId: result.sessionId, resultTokenHash: result.tokenHash, committedAt: result.committedAt }).where(eq(webClipTokenNonces.jtiHash, input.jtiHash));
      return { status: "committed" as const, result };
    });
  }
  async pruneExpired(before: Date, batchSize: number): Promise<number> {
    const rows = await this.#db.select({ jtiHash: webClipTokenNonces.jtiHash }).from(webClipTokenNonces).where(lte(webClipTokenNonces.expiresAt, before)).limit(batchSize);
    if (!rows.length) return 0; const deleted = await this.#db.delete(webClipTokenNonces).where(inArray(webClipTokenNonces.jtiHash, rows.map(({ jtiHash }) => jtiHash))).returning({ jtiHash: webClipTokenNonces.jtiHash }); return deleted.length;
  }
}
