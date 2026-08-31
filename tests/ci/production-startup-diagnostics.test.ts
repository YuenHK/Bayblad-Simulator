import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("production startup diagnostics", () => {
  it("reports only a bounded non-secret startup stage on fatal failure", () => {
    const source = readFileSync(new URL("../../apps/server/src/production-entry.ts", import.meta.url), "utf8");

    expect(source).toContain("startupStage");
    for (const stage of ["config", "database", "iclass", "admin", "server"]) {
      expect(source).toContain(`startupStage = "${stage}"`);
    }
    expect(source).toContain("startupStage, ...safeLogErrorDetails(error)");
    expect(source).toContain("configIssuePaths(error)");
    expect(source).toContain("configErrorCode(error)");
    expect(source).toContain("serverErrorCode(error)");
    expect(source).toContain('message === "DELETION_SOURCE_INSTANCE_ID mismatch"');
    expect(source).toContain('return "DELETION_SOURCE_INSTANCE_ID_MISMATCH"');
    expect(source).toContain("invalidArgumentName(error)");
    expect(source).toContain('new Set(["path", "key", "data", "input", "buffer", "string"])');
    expect(source).toContain("safeStackSites(error)");
    expect(source).toContain("node:internal\\/");
    expect(source).toContain("production-entry\\.mjs");
    expect(source).toContain('issue.path.join(".")');
  });
});
