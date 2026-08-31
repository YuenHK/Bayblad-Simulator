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
    expect(source).toContain('issue.path.join(".")');
  });
});
