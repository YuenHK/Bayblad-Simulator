import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");

describe("release CI contract", () => {
  const workflow = read(".github/workflows/ci.yml");
  const databaseWorkflow = read(".github/workflows/db.yml");
  const packageJson = JSON.parse(read("package.json")) as { scripts: Record<string, string> };

  it("pins the toolchain and runs every non-optional quality gate", () => {
    expect(packageJson.scripts.test).toContain("tests/ci");
    expect(workflow).toContain("node-version: 24.13.0");
    expect(workflow).toContain("version: 11.19.0");
    expect(workflow).toContain("permissions:\n  contents: read");
    expect(workflow.match(/persist-credentials: false/gu)?.length).toBeGreaterThanOrEqual(2);
    const allWorkflows = `${workflow}\n${databaseWorkflow}`;
    const uses = [...allWorkflows.matchAll(/uses:\s*[^@\s]+@([^\s#]+)/gu)].map((match) => match[1]);
    expect(uses.length).toBeGreaterThan(0);
    expect(uses.every((ref) => /^[a-f0-9]{40}$/u.test(ref!))).toBe(true);
    expect(workflow).toMatch(/image:\s*postgres@sha256:[a-f0-9]{64}/u);
    expect(databaseWorkflow).toMatch(/image:\s*postgres@sha256:[a-f0-9]{64}/u);
    expect(databaseWorkflow).toContain("persist-credentials: false");
    expect(workflow.match(/timeout-minutes:/gu)?.length).toBeGreaterThanOrEqual(3);
    expect(databaseWorkflow).toContain("timeout-minutes:");
    for (const command of ["pnpm lint", "pnpm typecheck", "pnpm test", "pnpm test:e2e", "pnpm --filter @steam-top/db test:postgres", "pnpm --filter @steam-top/server test:postgres"]) {
      expect(workflow).toContain(`run: ${command}`);
    }
  });

  it("validates Caddy and runs the production HTTPS security suite without the skip escape hatch", () => {
    const validator = read("scripts/validate-caddy.sh");
    expect(workflow).toContain("pnpm validate:caddy");
    expect(validator).toContain("caddy validate");
    expect(validator).toContain("caddy adapt");
    expect(validator).toContain("${CADDY_IMAGE_REPOSITORY}@${CADDY_IMAGE_DIGEST}");
    expect(workflow).toContain("up -d --wait");
    expect(workflow).toContain("SECURITY_HTTP_ORIGIN:");
    expect(workflow).toContain("SECURITY_HTTPS_ORIGIN:");
    expect(workflow).toContain("pnpm test:security");
    expect(workflow).not.toContain("SECURITY_ALLOW_SKIP");
    expect(workflow).not.toContain("SECURITY_TLS_INSECURE");
    expect(workflow).toContain("SECURITY_TLS_CA_FILE");
    expect(workflow).toContain("NODE_EXTRA_CA_CERTS");
    expect(workflow).toContain("TLS unexpectedly trusted before CA installation");
    expect(read("playwright.security.config.ts")).toContain("ignoreHTTPSErrors: false");
  });

  it("publishes immutable application images and an auditable release manifest", () => {
    expect(workflow).toContain("release-images:");
    expect(workflow).toContain("docker buildx build");
    expect(workflow).toContain("--provenance=mode=max");
    expect(workflow).toContain("scripts/create-release-manifest.mjs");
    expect(workflow).toContain("release-manifest");
    expect(workflow).toContain("actions/attest-build-provenance@");
    expect(workflow).toContain("portable-sha256.sh manifest release");
    expect(workflow).toContain("path: release/");
    expect(workflow).not.toContain("Resolve immutable base-image digests");
    expect(read("scripts/validate-deployment-env.mjs")).toContain("SERVER_IMAGE");
    expect(read("scripts/validate-deployment-env.mjs")).toContain("repository@sha256");
  });

  it("supports production deployment only through the fail-closed wrapper", () => {
    const deploy = read("scripts/deploy-production.sh");
    expect(deploy).toContain("authorize-production-deploy.mjs");
    expect(deploy).toContain("gh attestation verify");
    expect(deploy).toContain("portable-sha256.sh");
    expect(deploy.indexOf(" config --quiet")).toBeLessThan(deploy.indexOf(" pull"));
    expect(deploy.indexOf(" pull")).toBeLessThan(deploy.indexOf(" up -d --wait"));
    expect(read("docs/operations/release.md")).toContain("直接執行 `docker compose` 不受支援");
    expect(read("scripts/create-application-rollback.mjs")).toContain("database:current.images.database");
    expect(read("docs/operations/release.md")).toContain("prepare-application-rollback.sh");
  });

  it("always tears down the production-like stack", () => {
    expect(workflow).toMatch(/if:\s*always\(\)[\s\S]*down -v/u);
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
    expect(compose).toMatch(/migration:[\s\S]*image:\s*\$\{SERVER_IMAGE:\?/u);
    expect(compose).toMatch(/server:[\s\S]*image:\s*\$\{SERVER_IMAGE:\?/u);
    expect(compose).toMatch(/web:[\s\S]*image:\s*\$\{WEB_IMAGE:\?/u);
  });
});

describe("rollback deletion monotonicity", () => {
  const preflight = read("infra/backup/verify-rollback-preflight.sh");
  const promotion = read("infra/backup/promote-restored-target.sh");
  const release = read("docs/operations/release.md");

  it("fails closed when the external tombstone ledger advanced", () => {
    expect(preflight).toContain("deletion ledger advanced; database rollback forbidden");
    expect(preflight).toContain("deletion_ledger_sha256");
    expect(promotion).toContain("hold-lock");
    expect(promotion.indexOf("hold-lock")).toBeLessThan(promotion.indexOf("verify-backup-set.sh"));
    expect(promotion).toContain("signed immutable snapshot verification failed");
    expect(promotion).toContain("host-trust-guard.sh");
    expect(read("infra/backup/restore.sh")).toContain("host-trust-guard.sh");
    expect(read("infra/backup/host-trust-guard.sh")).toContain("PGPASSWORD/PGOPTIONS forbidden");
    expect(read("infra/backup/host-trust-guard.sh")).toContain("backup_canonical_path");
    expect(read("infra/backup/host-trust-guard.sh")).toContain('backup_root_file_mode "$canonical_cli" 555');
    expect(read("infra/backup/host-trust-guard.sh")).toContain('backup_root_file_mode "$canonical_manifest" 444');
    expect(promotion).toContain("environment='production',restore_allowed=false");
    expect(promotion).toContain("pg_terminate_backend");
    expect(promotion).toContain("allow_connections false");
    expect(promotion).toContain("PROMOTE_MAINTENANCE_PGSERVICE");
    expect(promotion).toContain("connections-disabled");
    expect(promotion).toContain("revoke connect on database %I from public");
    expect(promotion).toContain("promotion-ready");
    expect(promotion).toContain("RECOVERY-REQUIRED");
    expect(read("infra/backup/finalize-cutover.sh")).toContain("DATABASE_URL_CUTOVER_SUCCEEDED");
    expect(read(".github/workflows/db.yml")).toContain("test-promotion-isolation.sh");
    expect(promotion.indexOf("allow_connections false")).toBeLessThan(promotion.indexOf("pg_terminate_backend"));
    expect(promotion.indexOf("pg_terminate_backend")).toBeLessThan(promotion.indexOf("pg_advisory_xact_lock"));
    expect(promotion).toMatch(/cleanup\(\)[\s\S]*allow_connections true/u);
    expect(promotion.indexOf("pg_advisory_xact_lock")).toBeLessThan(promotion.indexOf("count(*) from deletion_audit"));
    expect(release).toContain("禁止資料庫回復");
  });
});
