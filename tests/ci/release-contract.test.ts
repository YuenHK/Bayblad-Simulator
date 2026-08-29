import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");

describe("release CI contract", () => {
  const workflow = read(".github/workflows/ci.yml");
  const packageJson = JSON.parse(read("package.json")) as { scripts: Record<string, string> };

  it("pins the toolchain and runs every non-optional quality gate", () => {
    expect(packageJson.scripts.test).toContain("tests/ci");
    expect(workflow).toContain("node-version: 24.13.0");
    expect(workflow).toContain("version: 11.19.0");
    for (const command of ["pnpm lint", "pnpm typecheck", "pnpm test", "pnpm test:e2e", "pnpm --filter @steam-top/db test:postgres", "pnpm --filter @steam-top/server test:postgres", "docker compose build"]) {
      expect(workflow).toContain(`run: ${command}`);
    }
  });

  it("validates Caddy and runs the production HTTPS security suite without the skip escape hatch", () => {
    const validator = read("scripts/validate-caddy.sh");
    expect(workflow).toContain("pnpm validate:caddy");
    expect(validator).toContain("caddy validate");
    expect(validator).toContain("caddy adapt");
    expect(validator).toContain("${CADDY_IMAGE_REPOSITORY}@${CADDY_IMAGE_DIGEST}");
    expect(workflow).toContain("docker compose up -d --wait");
    expect(workflow).toContain("SECURITY_HTTP_ORIGIN:");
    expect(workflow).toContain("SECURITY_HTTPS_ORIGIN:");
    expect(workflow).toContain("pnpm test:security");
    expect(workflow).not.toContain("SECURITY_ALLOW_SKIP");
  });

  it("always tears down the production-like stack", () => {
    expect(workflow).toMatch(/if:\s*always\(\)[\s\S]*docker compose down -v/u);
  });
});

describe("migration entrypoint contract", () => {
  const script = read("scripts/migrate-and-start.sh");
  const compose = read("compose.yaml");
  const dockerfile = read("Dockerfile.server");

  it("fails stop, applies the exact application migration, and only then starts the server", () => {
    expect(script).toContain("set -eu");
    expect(script).toContain("node migrate-entry.mjs");
    expect(script.indexOf("node migrate-entry.mjs")).toBeLessThan(script.indexOf("exec node production-entry.mjs"));
    expect(script).not.toMatch(/\|\|\s*true/u);
  });

  it("keeps Compose on the single one-shot migration path", () => {
    expect(compose).toMatch(/migration:[\s\S]*command:\s*\["\.\/scripts\/migrate-and-start\.sh",\s*"--migrate-only"\]/u);
    expect(compose).toMatch(/server:[\s\S]*migration:\s*\{ condition: service_completed_successfully \}/u);
    expect(dockerfile).toContain("scripts/migrate-and-start.sh");
  });
});
