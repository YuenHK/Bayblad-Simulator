import { and, eq, gt, isNull } from "drizzle-orm";
import type { DatabaseClient } from "@steam-top/db";
import { webClipTokenNonces } from "@steam-top/db/schema";
import type { TokenNonceStore } from "./webclip-token";

export class PostgresTokenNonceStore implements TokenNonceStore {
  readonly durable = true;
  readonly #db: DatabaseClient["db"];
  constructor(db: DatabaseClient["db"]) { this.#db = db; }
  async issue(input: Readonly<{ jtiHash: string; deviceId: string; issuedAt: Date; expiresAt: Date }>): Promise<void> {
    await this.#db.insert(webClipTokenNonces).values(input);
  }
  async consume(jtiHash: string, now: Date): Promise<string | null> {
    const [consumed] = await this.#db.update(webClipTokenNonces).set({ usedAt: now }).where(and(eq(webClipTokenNonces.jtiHash, jtiHash), isNull(webClipTokenNonces.usedAt), gt(webClipTokenNonces.expiresAt, now))).returning({ deviceId: webClipTokenNonces.deviceId });
    return consumed?.deviceId ?? null;
  }
}
