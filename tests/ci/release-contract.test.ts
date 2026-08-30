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

  it("attests and seals one deterministic root runtime file manifest", () => {
    const preparer = read("scripts/prepare-deployment-authorization.sh");
    const host = read("scripts/host-deploy-and-receipt.sh");
    const finalize = read("infra/backup/finalize-cutover.sh");
    const verifier = read("scripts/verify-runtime-install.sh");
    expect(workflow).toContain("create-runtime-files-manifest.mjs");
    expect(workflow).toContain("subject-path: release/runtime-files.sha256");
    expect(workflow).toContain("/opt/steam-top-bootstrap/prepare-release.sh");
    expect(read("scripts/seal-runtime-install.sh")).toContain("runtime-install-receipt.json");
    expect(preparer).toContain('gh attestation verify "$snapshot/runtime-files.sha256"');
    for (const script of [preparer, host, finalize]) {
      expect(script).toContain("verify-runtime-install.sh");
      expect(script).toContain("RUNTIME_INSTALL_MANIFEST_SHA256");
    }
    expect(verifier).toContain("runtime-files.sha256");
    expect(verifier).toContain("runtime-install-receipt.json");
    expect(verifier).toContain("root-owned exact mode");
  });

  it("gates approved tag artifacts on the isolated complete host core", () => {
    expect(workflow).toContain("release-host-core-integration:");
    expect(workflow).toContain("github.event_name == 'workflow_call'");
    expect(read(".github/workflows/authorize-release.yml")).toContain("workflow_run:");
    expect(workflow).toContain("environment=release-host-integration");
    expect(workflow).toContain("/opt/steam-top-bootstrap/deploy-release.sh");
    expect(workflow).toContain("sudo -u steam-top-integration sudo");
    expect(workflow).not.toContain("sudo cp -a candidate/runtime");
    const canonical=workflow.indexOf("Activate the actual host receipt and complete canonical integration cutover");
    const approved=workflow.indexOf("Mark the release approved only after canonical cutover");
    expect(canonical).toBeGreaterThan(0);
    expect(approved).toBeGreaterThan(canonical);
    expect(workflow).toContain("test-host-core-cutover-hook.sh");
    expect(workflow).toContain("DATABASE_URL=postgresql://steam_top_app:");
    expect(read("infra/backup/test-host-core-cutover-hook.sh")).toContain("production-smoke.sh");
    expect(workflow).toContain("receipt_generation/payload.json");
    expect(workflow).toContain("approved-release-${{ inputs.candidate_commit }}");
    expect(workflow).toContain("down -v --remove-orphans");
    const record=read(".github/workflows/record-deployment.yml");
    expect(record).toContain("approved-release-[a-f0-9]{40}");
    expect(record).toContain("APPROVED-RELEASE.json");
  });

  it("supports production deployment only through the fail-closed wrapper", () => {
    const deploy = read("scripts/deploy-production.sh");
    const preparer = read("scripts/prepare-deployment-authorization.sh");
    expect(deploy).toContain("authorize-production-deploy.mjs");
    expect(deploy).not.toContain("gh attestation verify");
    expect(deploy).not.toContain("gh api");
    expect(preparer).toContain("gh attestation verify");
    expect(preparer).toContain("gh api");
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
  it("reconciles the uniquely bound production E2E deployment without enumerating payloads",()=>{const workflow=read(".github/workflows/reconcile-production-e2e.yml"),ci=read(".github/workflows/ci.yml"),job=ci.slice(ci.indexOf("  production-first-deploy-e2e:"),ci.indexOf("  release-images:"));for(const text of ["workflow_run:","run_attempt","authorizationRunId","authorizationRunAttempt","candidate-run.json","production-e2e-source-binding.json","production-e2e-terminal.json","gh attestation verify","reconciliation-receipts.jsonl","attest-build-provenance","desired=error","terminal status conflict requires manual review"])expect(workflow).toContain(text);expect(workflow).not.toContain('deployments?environment=production-first-deploy-e2e');expect(workflow).not.toContain('state:"success"');expect(job).toContain("Attest the immutable production E2E source binding");expect(job).toContain("production-e2e-source-binding-${{ github.run_attempt }}");expect(job).toContain("Prepare the authoritative terminal receipt");const create=job.indexOf('deployments" --input pending-production.json'),persist=job.indexOf("PRODUCTION_E2E_DEPLOYMENT_ID=%s"),binding=job.indexOf("production-e2e-source-binding.json"),attest=job.indexOf("Attest the immutable production E2E source binding"),fallible=job.indexOf("create-bootstrap-authorization.mjs");expect(create).toBeGreaterThan(0);expect(create).toBeLessThan(persist);expect(persist).toBeLessThan(binding);expect(binding).toBeLessThan(attest);expect(attest).toBeLessThan(fallible);});
  it("uses a unique per-run environment and error-only fallback when source binding is absent",()=>{const ci=read(".github/workflows/ci.yml"),reconcile=read(".github/workflows/reconcile-production-e2e.yml");expect(ci).toContain('production-first-deploy-e2e-${{ github.run_id }}-${{ github.run_attempt }}');expect(reconcile).toContain('if [[ -f $binding ]]');expect(reconcile).toContain('deployments?environment=$exact_environment');expect(reconcile).toContain('desiredTerminal:"error"');expect(reconcile).not.toContain('state:"success"');});
  it("preflights the sole fully bound orphan before an idempotent error write",()=>{const reconcile=read(".github/workflows/reconcile-production-e2e.yml"),classifier=read("scripts/classify-production-e2e-fallback.mjs"),ci=read(".github/workflows/ci.yml");for(const text of ["authorizationWorkflowRef","authorizationWorkflowSha","sourceWorkflow","sourceEvent","created_at",".sort(","plan.conflicts","plan.pending"])expect(classifier).toContain(text);for(const text of ["per_page=2","fallback-statuses","fallback-plan","already-error",'outcome:"no-deployment"','outcome:"candidate-conflict"',"fallback-statuses-before.json","fallback-statuses-after.json"])expect(reconcile).toContain(text);expect(reconcile).not.toContain("FALLBACK_CANDIDATE_CAP");expect(reconcile.indexOf(".conflicts.length")).toBeLessThan(reconcile.indexOf('gh api --method POST "repos/$GITHUB_REPOSITORY/deployments/$id/statuses"'));expect(ci).toContain('group: production-deployment-status-authority');expect(reconcile).toContain('group: production-deployment-status-authority');});
  it("enforces the exact protected Deployment writer policy with parsed YAML",()=>{const policy=read("scripts/verify-deployment-permissions.mjs"),ci=read(".github/workflows/ci.yml");for(const text of ["YAML.safe_load","aliases:true","explicit top-level permissions required","write-all forbidden","dynamic permissions forbidden","unauthorized local reusable workflow caller","authorize-release.yml","reconcile-deployment.yml","reconcile-production-e2e.yml","record-deployment.yml","production-first-deploy-e2e","release-host-core-integration","unauthorized deployments:write","workflow_call guard"])expect(policy).toContain(text);expect(ci).toContain("node scripts/verify-deployment-permissions.mjs");});
  it("authoritatively verifies candidate policy from an externally pinned protected checkout",()=>{const workflow=read(".github/workflows/authorize-release.yml"),eligibility="github.event.workflow_run.conclusion == 'success' && github.event.workflow_run.event == 'push' && startsWith(github.event.workflow_run.head_branch, 'v')";expect(workflow.match(new RegExp(eligibility.replace(/[.*+?^${}()|[\]\\]/g,"\\$&"),"g"))?.length).toBe(2);for(const text of ["verify-candidate-policy:","environment: production-release-policy-approval",'ref: "${{ github.workflow_sha }}"',"fetch-depth: 0","path: trusted",'ref: "${{ github.event.workflow_run.head_sha }}"',"path: candidate",'/usr/bin/node "$GITHUB_WORKSPACE/trusted/scripts/verify-deployment-permissions.mjs"','ORG_VARIABLE_READER_TOKEN: "${{ secrets.PRODUCTION_POLICY_ORG_VARIABLE_READER_TOKEN }}"',"STEAM_TOP_POLICY_ANCHOR_JSON_B64","anchorGeneration","verify-production-policy-bundle.mjs","compare/$TRUSTED_WORKFLOW_SHA...$default_head","merge_base_commit","TRUSTED_WORKFLOW_SHA","source-run.json","deployment-policy-evidence.json","verifierSha256","policySha256","policyBundleSha256","attest-build-provenance","needs: verify-candidate-policy"])expect(workflow).toContain(text);expect(workflow).not.toContain("${{ vars.PRODUCTION_POLICY_");expect(workflow).not.toContain('commits/$default_branch" --jq .sha)" = "$TRUSTED_WORKFLOW_SHA');expect(workflow.slice(workflow.indexOf("  authorize:"),workflow.length)).not.toContain("concurrency:");});
  it("computes a rotation pin only from a sanitized SHA-1 full-OID snapshot",()=>{const helper=read("scripts/print-production-policy-pin.sh"),verifier=read("scripts/verify-production-policy-bundle.mjs");for(const text of ["$#!=1","full-40-hex-sha1-commit-oid","--show-object-format","/usr/bin/env -i","GIT_CONFIG_NOSYSTEM=1","remote add origin \"file://$root\"","fetch --quiet --depth=1 --no-tags","objects/info/alternates","checkout --detach","source_commit"])expect(helper).toContain(text);for(const text of ["/usr/bin/git","baseEnvironment","GIT_CONFIG_GLOBAL","GIT_INDEX_FILE","copyFileSync","write-tree","HEAD^{tree}","--really-refresh","diff-files","--ignored=matching","cat-file","entry.oid","TextDecoder","normalize(\"NFC\")","finally"])expect(verifier).toContain(text);});
  it("rotates policy only from trusted code with protected org anchor",()=>{const launcher=read("scripts/production-policy-pin-launcher.sh"),helper=read("scripts/print-production-policy-pin.sh"),workflow=read(".github/workflows/rotate-production-policy.yml");for(const text of ["usage: %s <repository> <full-40-hex-oid>","cat-file blob"])expect(launcher).toContain(text);for(const text of ["PYTHONNOUSERSITE=1","python3 -I -E -S","kill -0 -- \"-$active_pid\""])expect(helper).toContain(text);for(const text of ["production-policy-rotation-authority","PRODUCTION_POLICY_ORG_VARIABLE_READER_TOKEN","STEAM_TOP_POLICY_ANCHOR_JSON_B64","policyTreeOid","fetch-depth: 0","trusted/scripts/verify-production-policy-bundle.mjs","compare/$REVIEWED_COMMIT...$default_head","production-policy-rotation-intent","authorized:false"])expect(workflow).toContain(text);expect(workflow).not.toContain("${{ vars.PRODUCTION_POLICY_");expect(workflow).not.toContain("production-policy-pin-launcher.sh")});
  it("never returns success for an idempotent failure terminal receipt",()=>{const ci=read(".github/workflows/ci.yml"),job=ci.slice(ci.indexOf("Publish the single terminal production E2E status"),ci.indexOf("  release-images:"));expect(job).toContain('[[ $state == success ]]&&exit 0');expect(job).not.toContain('then exit 0;else code=');});
  it("uses a dedicated cluster and non-owner application identity only after migration and pristine claim",()=>{const deploy=read("scripts/deploy-production.sh"),runtime=read("scripts/create-runtime-files-manifest.mjs"),compose=read("compose.canonical-app.yaml"),provision=read("scripts/provision-app-role.sql"),ci=read(".github/workflows/ci.yml");expect(runtime).toContain("compose.canonical-app.yaml");expect(compose).toContain("!override");expect(deploy.indexOf('run --rm migration')).toBeLessThan(deploy.indexOf("provision-app-role.sql"));expect(deploy.indexOf("claim-first-installation.sh")).toBeLessThan(deploy.indexOf("provision-app-role.sql"));for(const text of ["pg_advisory_xact_lock","dedicated PostgreSQL cluster required","datname NOT IN(current_database(),'postgres','template0','template1')","REVOKE CONNECT ON DATABASE postgres FROM PUBLIC,steam_top_app","has_database_privilege('steam_top_app',d.datname,'CONNECT')","REVOKE CREATE ON SCHEMA public FROM PUBLIC","REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public,restore_control"])expect(provision).toContain(text);expect(provision.indexOf("dedicated PostgreSQL cluster required")).toBeLessThan(provision.indexOf("CREATE ROLE steam_top_app"));for(const text of ["APP_DATABASE_URL","compose.json","test ! -e /run/secrets/database_url"])expect(ci).toContain(text);});
  it("uploads only allowlisted and secret-scanned short-lived E2E diagnostics",()=>{const ci=read(".github/workflows/ci.yml"),job=ci.slice(ci.indexOf("  production-first-deploy-e2e:"),ci.indexOf("  release-images:"));expect(job).not.toContain("docker logs");expect(job).toContain("container-authority.txt");expect(job).toContain("REDACTED.sha256");expect(job).toContain("retention-days: 14");expect(job).toContain("Publish the single terminal production E2E status");});
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
    expect(promotion).toContain("promotion must run as root");
    expect(promotion).not.toContain("restore_acl");
    expect(promotion).toContain("configured APP_UID-owned 0600");
    expect(promotion).toContain(".promotion-reserved");
    expect(promotion).toContain("reconcile-promotion-ready.sh");
    expect(promotion).toContain("promotion_outbox");
    const reconcilePromotion = read("infra/backup/reconcile-promotion-ready.sh");
    expect(reconcilePromotion).toContain(".promotion-ready.$nonce.$$");
    expect(reconcilePromotion).toContain('r.promotionNonce!==process.argv[8]');
    const finalize = read("infra/backup/finalize-cutover.sh");
    expect(finalize).not.toContain("DATABASE_URL_CUTOVER_SUCCEEDED");
    expect(finalize).not.toContain("readarray");
    expect(finalize).toContain("backup_trusted_root_deployment");
    expect(finalize).toContain("CUTOVER_ALLOWED_SIGNERS_FILE");
    expect(finalize).toContain("ledgerRows");
    expect(finalize).toContain("promotion_audit");
    expect(finalize).toContain("finalize_outbox");
    expect(finalize).toContain("public smoke confirmation required");
    for (const binding of ["PRODUCTION_ENV_FILE", "PROTECTED_DEPLOYMENT_STATE_FILE", "HOST_DEPLOYMENT_RECEIPT_FILE", "HOST_DEPLOYMENT_RECEIPT_SIGNATURE"])
      expect(finalize).toContain(binding);
    expect(finalize).toContain("steam-top-production-deployment");
    const cutoverPreflight=read("infra/backup/record-cutover-receipt.sh");
    expect(cutoverPreflight).not.toContain("production-smoke.sh");
    expect(cutoverPreflight).toContain("preflight-recorded");
    expect(cutoverPreflight).toContain("has_database_privilege");
    expect(finalize).toContain("connect-granted-pending-smoke");
    expect(finalize).not.toContain("state='consumed'");
    const confirm=read("infra/backup/confirm-cutover.sh"),abort=read("infra/backup/abort-cutover.sh");
    expect(confirm).toContain("state='verified'");
    expect(confirm).toContain("steam-top-public-cutover-smoke");
    expect(abort).toContain("state='aborted'");
    expect(abort).toContain("revoke connect on database %I from %I");
    expect(read("infra/backup/test-promotion-full.sh")).toContain("reconcile-promotion-ready.sh");
    expect(read("infra/backup/test-promotion-full.sh")).toContain("confirm-cutover.sh");
    expect(read("infra/backup/test-promotion-full.sh")).toContain("connect-granted-pending-smoke");
    const wss=read("scripts/production-wss-smoke.mjs");expect(wss.indexOf("rhythm coverage deadline")).toBeLessThan(wss.lastIndexOf('socket.off("server.event"'));
    const cutover=read("infra/backup/record-cutover-receipt.sh");expect(cutover).toContain("existing cutover receipt conflict");expect(cutover).toContain("steam-top-cutover-preflight");expect(cutover).toContain("preflight-recorded");
    expect(read(".github/workflows/db.yml")).toContain("test-promotion-isolation.sh");
    expect(read(".github/workflows/db.yml")).toContain("test-canonical-cutover-full.sh");
    const canonical = read("infra/backup/test-canonical-cutover-full.sh");
    expect(read(".github/workflows/ci.yml")).toContain("test-canonical-cutover-full.sh");
    for (const entrypoint of ["/opt/steam-top-bootstrap/activate-production-state.sh", "/opt/steam-top/releases/", "/opt/steam-top-bootstrap/record-cutover-current.sh", "/opt/steam-top-bootstrap/finalize-current.sh", "promote-restored-target.sh"])
      expect(canonical).toContain(entrypoint);
    expect(canonical).toContain("steam-top-production.lock");
    expect(canonical).toContain("import-legacy-cutover-current.sh");expect(canonical).toContain("legacy_ready_sha_text_b64");expect(canonical).toContain("legacy-committed");
    expect(canonical).toContain("expected activation B to be locked out");
    expect(canonical).toContain("promotion_audit");
    expect(canonical).toContain("runtime current mismatch");
    expect(canonical).toContain("ledger-ci-old");
    expect(canonical).toContain("old ledger signer removal unexpectedly accepted");
    expect(read("compose.canonical-app.yaml")).toContain("steam_top_app");
    expect(read(".github/workflows/ci.yml")).toContain("--force-recreate --wait server");
    expect(read("infra/backup/test-promotion-full.sh")).toContain("promote-restored-target.sh");
    expect(read("infra/backup/test-promotion-full.sh")).toContain("finalize-cutover.sh");
    expect(read("infra/backup/test-promotion-full.sh")).toContain("promotion_audit");
    expect(read("infra/backup/test-promotion-full.sh")).toContain("pg_signal_backend");
    expect(read("infra/backup/test-promotion-full.sh")).toContain("state-inherited");
    expect(read("infra/backup/test-promotion-full.sh")).toContain("grant %I to %I");
    expect(read("infra/backup/test-promotion-full.sh")).toContain("t|test|t");
    expect(read("infra/backup/test-promotion-full.sh")).toContain("PROMOTE_MAINTENANCE_PGSERVICE=wrong-cluster");
    expect(read(".github/workflows/db.yml")).toContain("postgres-wrong-cluster:");
    expect(read(".github/workflows/db.yml")).toContain("5433:5432");
    const cutoverMigration=read("drizzle/0001_cutover_state_machine.sql");
    for(const state of ["legacy-committed","preflight-recorded","connect-granted-pending-smoke","smoke-observed","verified","aborted"])expect(cutoverMigration).toContain(state);
    expect(cutoverMigration).toContain("pg_get_expr");expect(cutoverMigration).toContain("legacy.conkey[1]<>state_attnum");expect(cutoverMigration).toContain("conname='finalize_outbox_state_check'");expect(cutoverMigration).not.toContain("FOR legacy IN");
    const legacyImport=read("infra/backup/import-legacy-cutover.sh"),legacyValidator=read("scripts/validate-legacy-cutover-evidence.mjs");expect(legacyImport).toContain("CANONICAL_STATE_RESOLVED");expect(legacyImport).toContain("state='legacy-committed'");expect(legacyImport).toContain("final_receipt_signature_b64");expect(legacyValidator).toContain('exact(receipt,["schemaVersion","purpose","readySha256","systemIdentifier","database","appRole","restoreTargetId","ledgerRows","databaseUrlSha256","deploymentManifestSha256","publicOrigin","publicSmoke","promotionNonce","createdAt"])');expect(legacyImport).toContain("steam-top-cutover");expect(legacyImport).toContain("legacy ready digest");
    expect(read("infra/bootstrap/import-legacy-cutover-current.sh")).toContain("verify-runtime-install.sh");
    for(const column of ["deadline_at","lease_owner","lease_generation","ledger_hash","ready_sha256","preflight_sha256","smoke_evidence_payload_b64","smoke_evidence_sha256","final_receipt_sha256","final_receipt_payload_b64","legacy_ready_payload_b64","legacy_ready_sha_text_b64"])expect(cutoverMigration).toContain(column);
    expect(cutoverMigration).toContain("deletion_audit_sha256");
    expect(read(".github/workflows/db.yml")).toContain("test-cutover-migration.sh");
    const installation=read("drizzle/0002_platform_installation.sql"),claim=read("scripts/claim-first-installation.sh"),firstState=read("infra/bootstrap/advance-first-deploy-state.sh");expect(installation).toContain("platform_installation");expect(installation).toContain("app_schema_migrations");expect(installation).toContain("restore authority schema drift");for(const migration of ["0000_steam_top_pre_first_deploy","0001_cutover_state_machine","0002_platform_installation"])expect(installation).toContain(migration);expect(claim).toContain("pg_advisory_xact_lock");expect(claim).toContain("steam_top.expected_platform_migration_sha");expect(claim).toContain("database is not pristine");expect(firstState).toContain("pending:db-claimed");expect(firstState).toContain("db-claimed:consumed");expect(read(".github/workflows/db.yml")).toContain("test-platform-installation.sh");
    const reaper=read("infra/backup/reconcile-cutover-pending.sh");expect(reaper).toContain("deadline_at < clock_timestamp()");expect(reaper).toContain("'smoke-observed'");expect(reaper).toContain("state='aborted'");expect(read("infra/systemd/steam-top-cutover-reaper.timer")).toContain("OnUnitActiveSec");
    const installer=read("infra/bootstrap/install-bootstrap.sh");expect(installer).toContain("--install-systemd");expect(installer).toContain("--no-systemd-for-integration");expect(installer).toContain("--initialize-first-deploy");expect(installer).toContain("install-receipts");expect(installer).toContain(".steam-top-bootstrap.stage.");expect(installer.indexOf("clean production install requires explicit")).toBeLessThan(installer.indexOf("mktemp -d /opt/"));expect(installer).toContain("production requires systemd");expect(installer).toContain("systemd-analyze verify");expect(installer).toContain("systemctl enable --now steam-top-cutover-reaper.timer");
    expect(read("infra/bootstrap/verify-reaper-health.sh")).toContain("ExecMainStatus");expect(read("infra/bootstrap/verify-reaper-health.sh")).toContain("not-applicable-clean-host");expect(read("infra/systemd/steam-top-cutover-reaper.service")).not.toContain("ConditionPathExists");
    expect(read(".github/workflows/record-deployment.yml")).toContain("sudo /opt/steam-top-bootstrap/verify-reaper-health.sh");
    const recordWorkflow=read(".github/workflows/record-deployment.yml");expect(recordWorkflow.indexOf('verify-reaper-health.sh"')).toBeLessThan(recordWorkflow.indexOf("deploy-release.sh"));expect(recordWorkflow.indexOf("activate-production-state.sh")).toBeLessThan(recordWorkflow.indexOf("verify-reaper-health.sh --require-active-runtime"));const firstDeploy=read("scripts/deploy-production.sh");expect(firstDeploy.indexOf('up -d --wait db')).toBeLessThan(firstDeploy.indexOf('run --rm migration'));expect(firstDeploy.indexOf('run --rm migration')).toBeLessThan(firstDeploy.indexOf("--post-migration-first-deploy"));expect(firstDeploy.indexOf("--post-migration-first-deploy")).toBeLessThan(firstDeploy.lastIndexOf('up -d --wait'));
    const ciWorkflow=read(".github/workflows/ci.yml"),compose=read("compose.yaml"),job=ciWorkflow.slice(ciWorkflow.indexOf("  production-first-deploy-e2e:"),ciWorkflow.indexOf("  release-images:"));expect(job).toContain("needs: release-host-core-integration");expect(job).toContain("DEPLOYMENT_PURPOSE=production node scripts/create-pending-deployment.mjs");expect(job).toContain("$GITHUB_REPOSITORY/.github/workflows/ci.yml");expect(job).toContain("github.workflow_sha");expect(job).toContain("github.workflow_ref");expect(job).not.toContain("$GITHUB_REPOSITORY/.github/workflows/authorize-release.yml");expect(job).toContain("verify-bootstrap-source-run.mjs");expect(job).toContain("verify-attestation-identity.mjs");expect(job).toContain("--install-systemd --initialize-first-deploy");expect(job).toContain("deploy-release.sh --prepared-authorization");expect(job).toContain("activate-production-state.sh");expect(job).toContain("verify-reaper-health.sh --require-active-runtime");expect(job).toContain("^consumed $PRODUCTION_E2E_NONCE");expect(job).toContain("generation=2");expect(job).toContain("production-first-deploy-e2e-diagnostics");expect(job).toContain("Publish the single terminal production E2E status");expect(job.match(/deployments\/\$PRODUCTION_E2E_DEPLOYMENT_ID\/statuses/g)?.length).toBeGreaterThanOrEqual(2);expect(job).toContain("--paginate --slurp");expect(job).toContain("down -v --remove-orphans");expect(compose).toContain('127.0.0.1:${POSTGRES_HOST_PORT:-15432}:5432');
    const confirmCutover=read("infra/backup/confirm-cutover.sh");expect(confirmCutover).toContain("smoke_evidence_payload_b64");expect(confirmCutover).toContain("final_receipt_payload_b64");expect(confirmCutover).toContain("existing_state == verified");expect(confirmCutover).toContain("verified receipt has no durable signature");expect(confirmCutover).toContain("final directory custody");expect(confirmCutover).toContain("flag:\"wx\"");expect(read("infra/bootstrap/confirm-cutover-current.sh")).toContain("cutoverIncidentDir");
    expect(read("scripts/parse-confirmed-cutover.mjs")).toContain("steam-top-public-cutover-smoke");expect(read("infra/backup/import-legacy-cutover.sh")).toContain("$mode == 440");expect(read("infra/bootstrap/read-first-deploy-state.sh")).toContain("steam-top-first-deploy-state");
    expect(read("infra/backup/test-promotion-full.sh")).toContain("wait_advisory 2");
    expect(read(".github/workflows/ci.yml")).toMatch(/Abort any provisional cutover[\s\S]*if: always\(\)[\s\S]*aborted\\\|t\\\|t/u);
    expect(promotion).toContain("not has_database_privilege(:'app_role'");
    expect(promotion.indexOf("allow_connections false")).toBeLessThan(promotion.indexOf("pg_terminate_backend"));
    expect(promotion.indexOf("pg_terminate_backend")).toBeLessThan(promotion.indexOf("pg_advisory_xact_lock"));
    expect(promotion).toMatch(/cleanup\(\)[\s\S]*allow_connections true/u);
    expect(promotion.indexOf("pg_advisory_xact_lock")).toBeLessThan(promotion.indexOf("count(*) from deletion_audit"));
    expect(release).toContain("禁止資料庫回復");
  });
});
