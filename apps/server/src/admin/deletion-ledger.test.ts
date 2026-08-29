import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { FileDeletionLedger } from "./deletion-ledger";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
it("durably appends idempotent pending and committed content-free tombstones", async () => { const root = await mkdtemp(join(tmpdir(), "delete-ledger-")); roots.push(root); const path = join(root, "private", "ledger.log"), ledger = new FileDeletionLedger(path), input={ auditId: "10000000-0000-4000-8000-000000000001", operationDigest: "a".repeat(64) }; await ledger.recordPending(input); await ledger.recordCommitted(input);await ledger.recordCommitted(input); const value = await readFile(path, "utf8"); expect(value.split("\n").filter(Boolean)).toEqual([`P ${input.auditId} ${input.operationDigest}`,`C ${input.auditId} ${input.operationDigest}`]); expect(value).not.toContain("1A"); });
it("requires an absolute path", () => { expect(() => new FileDeletionLedger("ledger.log")).toThrow(/ABSOLUTE/u); });
