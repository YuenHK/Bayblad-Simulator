import { chmod, lstat, mkdir, open, readFile } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";

export interface DeletionLedger { recordPending(input: Readonly<{ auditId: string; operationDigest: string }>): Promise<void>; recordCommitted(input: Readonly<{ auditId: string; operationDigest: string }>): Promise<void>; recordAborted(input: Readonly<{ auditId: string; operationDigest: string }>): Promise<void>; }

/** External append-only tombstones make backups predating a deletion ineligible for restore. */
export class FileDeletionLedger implements DeletionLedger {
  constructor(readonly path: string) { if (!isAbsolute(path)) throw new TypeError("DELETION_LEDGER_FILE_MUST_BE_ABSOLUTE"); }
  async #record(state: "P" | "C" | "A", input: { auditId: string; operationDigest: string }): Promise<void> {
    if (!/^[0-9a-f-]{36}$/iu.test(input.auditId) || !/^[a-f0-9]{64}$/u.test(input.operationDigest)) throw new TypeError("INVALID_DELETION_TOMBSTONE");
    const directory = dirname(this.path); await mkdir(directory, { recursive: true, mode: 0o700 }); await chmod(directory, 0o700);
    try { const info = await lstat(this.path); if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024 * 1024) throw new Error("UNSAFE_DELETION_LEDGER"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const line=`${state} ${input.auditId.toLowerCase()} ${input.operationDigest}\n`;
    try { if ((await readFile(this.path,"utf8")).split("\n").includes(line.trimEnd())) return; } catch (error) { if ((error as NodeJS.ErrnoException).code!=="ENOENT") throw error; }
    const file = await open(this.path, "a", 0o600);
    try { await file.write(line); await file.datasync(); await file.chmod(0o600); }
    finally { await file.close(); }
  }
  recordPending(input: { auditId: string; operationDigest: string }) { return this.#record("P", input); }
  recordCommitted(input: { auditId: string; operationDigest: string }) { return this.#record("C", input); }
  recordAborted(input: { auditId: string; operationDigest: string }) { return this.#record("A", input); }
}
