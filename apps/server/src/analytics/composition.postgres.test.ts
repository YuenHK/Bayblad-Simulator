import { afterAll, describe, expect, it } from "vitest";
import { createDatabaseClient, type DatabaseClient } from "@steam-top/db";
import { createProductionAnalytics } from "./composition";

const databaseUrl = process.env.ANALYTICS_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
let client: DatabaseClient | undefined;

suite("production analytics composition", () => {
  afterAll(async () => { await client?.close(); });

  it("returns an empty-window summary through the production transaction and cache path", async () => {
    client = createDatabaseClient({ url: databaseUrl!, ssl: "require", maxConnections: 2 });
    const analytics = createProductionAnalytics(client);

    await expect(analytics.query({ from: "2026-08-01", to: "2026-08-31" }, 0)).resolves.toMatchObject({
      usage: expect.any(Array),
      usagePeriods: { daily: expect.any(Array), weekly: expect.any(Array), monthly: expect.any(Array) },
      parameters: expect.any(Array),
      parameterUsage: expect.any(Array),
    });
    await expect(analytics.query({ from: "2026-08-01", to: "2026-08-31" })).resolves.toMatchObject({
      usage: expect.any(Array),
      refreshedAt: expect.stringMatching(/^2026-/u),
    });
  }, 30_000);
});
