import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Docker build tooling", () => {
  it("declares esbuild at the workspace root used by Dockerfile.server", () => {
    const manifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
      devDependencies?: Record<string, string>;
    };

    expect(manifest.devDependencies?.esbuild).toBe("0.28.2");
  });
});
