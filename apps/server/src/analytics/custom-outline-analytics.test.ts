import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { parameterUsage } from "./parameter-usage";
import { parameterPerformance } from "./parameters";
import { SHEETS } from "../exports/workbook";

describe("custom outline analytics projections", () => {
  it("classifies drawing modes and treats sampled custom points as not applicable", async () => {
    const captured: string[] = [];
    const db = { execute: async (query: SQL) => { captured.push(new PgDialect().sqlToQuery(query).sql); return []; } };
    const filters = { from: "2026-09-01", to: "2026-09-27" };
    await parameterUsage(db as unknown as Parameters<typeof parameterUsage>[0], filters);
    await parameterPerformance(db as unknown as Parameters<typeof parameterPerformance>[0], filters);
    for (const query of captured) {
      expect(query).toContain("'shapeCategory'");
      expect(query).toContain("'mirrorMode'");
      expect(query).toContain("when 'custom' then 'NA'");
      expect(query).toContain("in ('circle','custom') then null");
    }
  });
  it("exports compact category and mirror columns, not raw vertices", () => {
    const keys = SHEETS.find(sheet => sheet.key === "designs")!.columns.map(column => column.key);
    expect(keys).toEqual(expect.arrayContaining(["shapeCategory", "mirrorMode", "mirrorSectors"]));
    expect(keys).not.toContain("vertices");
  });
});
