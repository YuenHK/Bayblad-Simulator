#!/usr/bin/env node
import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
const [rootArg, installerArg] = process.argv.slice(2);
if (!rootArg || !installerArg) process.exit(2);
const root = resolve(rootArg);
const lines = (await readFile(join(root, "bootstrap-files.sha256"), "utf8")).split("\n").filter(Boolean);
const expected = new Map();
for (const line of lines) {
  const match = /^([a-f0-9]{64}) (0444|0555) ([A-Za-z0-9][A-Za-z0-9._-]*)$/.exec(line);
  if (!match || expected.has(match[3]) || match[3] === "bootstrap-files.sha256") throw new Error("invalid bootstrap manifest");
  expected.set(match[3], { digest: match[1], mode: Number.parseInt(match[2], 8) });
}
if (!expected.has("install-bootstrap.sh") || !expected.has("verify-package-tree.mjs")) throw new Error("bootstrap manifest omits trust entrypoint");
const actual = (await readdir(root)).sort();
const wanted = [...expected.keys(), "bootstrap-files.sha256"].sort();
if (JSON.stringify(actual) !== JSON.stringify(wanted)) throw new Error("bootstrap archive contains missing or unexpected entries");
for (const [name, item] of expected) {
  const path = join(root, name); const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== item.mode) throw new Error(`invalid bootstrap file metadata: ${name}`);
  const digest = createHash("sha256").update(await readFile(path)).digest("hex");
  if (digest !== item.digest) throw new Error(`invalid bootstrap file digest: ${name}`);
}
const installerDigest = createHash("sha256").update(await readFile(resolve(installerArg))).digest("hex");
if (installerDigest !== expected.get("install-bootstrap.sh").digest) throw new Error("running installer is not the signed installer");
