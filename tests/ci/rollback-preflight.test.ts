import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";

const execute = promisify(execFile);

async function fixture(ledger: string) {
  const root = await mkdtemp(join(tmpdir(), "rollback-preflight-"));
  const backup = join(root, "steam-top-20260101T000000Z-000001.backup");
  const external = join(root, "ledger.log");
  await mkdir(backup);
  await writeFile(join(backup, "COMPLETE"), "complete\n");
  await writeFile(external, ledger);
  const sha = createHash("sha256").update(ledger).digest("hex");
  await writeFile(join(backup, "manifest"), `deletion_ledger_lines=${ledger.split("\n").filter(Boolean).length}\ndeletion_ledger_sha256=${sha}\n`);
  return { backup, external };
}

describe("rollback tombstone preflight", () => {
  it("accepts only a byte-exact current external ledger", async () => {
    const target = await fixture("P first\nC first\n");
    await expect(execute("./infra/backup/verify-rollback-preflight.sh", [target.backup, target.external])).resolves.toMatchObject({ stdout: expect.stringContaining("verified") });
    await writeFile(target.external, "P first\nC first\nP later\nC later\n");
    await expect(execute("./infra/backup/verify-rollback-preflight.sh", [target.backup, target.external])).rejects.toMatchObject({ stderr: expect.stringContaining("database rollback forbidden") });
  });
});
