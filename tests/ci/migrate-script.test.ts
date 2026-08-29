import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execute = promisify(execFile);

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "steam-top-migration-script-"));
  const log = join(root, "calls");
  const node = join(root, "node");
  await writeFile(node, '#!/bin/sh\nprintf "%s\\n" "$1" >> "$CALL_LOG"\n[ "$1" != migrate-entry.mjs ] || [ "${FAIL_MIGRATION:-0}" != 1 ] || exit 42\n', { mode: 0o755 });
  await chmod(node, 0o755);
  return { log, env: { ...process.env, PATH: `${root}:${process.env.PATH}`, CALL_LOG: log } };
}

describe("migrate-and-start", () => {
  it("rejects an unknown mode before touching the database", async () => {
    const target = await fixture();
    await expect(execute("./scripts/migrate-and-start.sh", ["--unknown"], { env: target.env })).rejects.toMatchObject({ code: 64 });
    await expect(readFile(target.log, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails stop and never starts the server after migration failure", async () => {
    const target = await fixture();
    await expect(execute("./scripts/migrate-and-start.sh", [], { env: { ...target.env, FAIL_MIGRATION: "1" } })).rejects.toMatchObject({ code: 42 });
    expect(await readFile(target.log, "utf8")).toBe("migrate-entry.mjs\n");
  });

  it("starts only after migration, while migrate-only exits after the gate", async () => {
    const combined = await fixture();
    await execute("./scripts/migrate-and-start.sh", [], { env: combined.env });
    expect(await readFile(combined.log, "utf8")).toBe("migrate-entry.mjs\nproduction-entry.mjs\n");
    const oneShot = await fixture();
    await execute("./scripts/migrate-and-start.sh", ["--migrate-only"], { env: oneShot.env });
    expect(await readFile(oneShot.log, "utf8")).toBe("migrate-entry.mjs\n");
  });
});
