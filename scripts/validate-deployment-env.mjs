import { readFileSync } from "node:fs";

const values = { ...process.env };
if (process.argv[2]) {
  for (const line of readFileSync(process.argv[2], "utf8").split(/\r?\n/u)) {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/u.exec(line);
    if (match) values[match[1]] = match[2];
  }
}
for (const prefix of ["NODE", "POSTGRES", "CADDY"]) {
  const repository = values[`${prefix}_IMAGE_REPOSITORY`] ?? "";
  const digest = values[`${prefix}_IMAGE_DIGEST`] ?? "";
  if (!repository || /[\s@]/u.test(repository)) throw new Error(`${prefix}_IMAGE_REPOSITORY must be a repository without @`);
  if (!/^sha256:[a-f0-9]{64}$/u.test(digest)) throw new Error(`${prefix}_IMAGE_DIGEST must be sha256: followed by 64 lowercase hex characters`);
}
const origin = new URL(values.PUBLIC_ORIGIN ?? "");
if (origin.protocol !== "https:" || origin.port || origin.pathname !== "/" || origin.search || origin.hash || origin.username || origin.password) throw new Error("PUBLIC_ORIGIN must be an HTTPS origin on the default port");
process.stdout.write("deployment environment references validated\n");
