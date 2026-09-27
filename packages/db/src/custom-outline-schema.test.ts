import { readFileSync } from "node:fs";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { designLayers, topShapeEnum } from "./schema";

describe("additive custom outline storage", () => {
  it("supports custom shapes and a nullable JSON outline without changing old columns", () => {
    expect(topShapeEnum.enumValues).toContain("custom");
    const config = getTableConfig(designLayers);
    const outline = config.columns.find(column => column.name === "outline");
    expect(outline).toBeDefined();
    expect(outline?.notNull).toBe(false);
    expect(config.checks.map(check => check.name)).toContain("design_layers_outline_matches_shape");
  });

  it("registers an additive migration without rewriting historical designs", () => {
    const sql = readFileSync(new URL("../../../drizzle/0005_custom_layer_outlines.sql", import.meta.url), "utf8");
    expect(sql).toContain("ADD VALUE IF NOT EXISTS 'custom'");
    expect(sql).toContain('ADD COLUMN "outline" jsonb');
    expect(sql).toContain('"shape"::text');
    expect(sql).not.toMatch(/\b(?:DELETE|DROP|UPDATE|TRUNCATE)\b/i);
    const journal = JSON.parse(readFileSync(new URL("../../../drizzle/meta/_journal.json", import.meta.url), "utf8"));
    expect(journal.entries.at(-1).tag).toBe("0005_custom_layer_outlines");
  });
});
