import { readFileSync } from "node:fs";

const values = { ...process.env };
if (process.argv[2]) {
  for (const line of readFileSync(process.argv[2], "utf8").split(/\r?\n/u)) {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/u.exec(line);
    if (match) values[match[1]] = match[2];
  }
}
const immutable = /^[^\s@]+@sha256:[a-f0-9]{64}$/u;
for (const name of ["NODE_IMAGE", "POSTGRES_IMAGE", "CADDY_IMAGE"]) {
  if (!immutable.test(values[name] ?? "")) throw new Error(`${name} must be an immutable image reference containing @sha256:`);
}
const origin = new URL(values.PUBLIC_ORIGIN ?? "");
if (origin.protocol !== "https:" || origin.port || origin.pathname !== "/" || origin.search || origin.hash || origin.username || origin.password) throw new Error("PUBLIC_ORIGIN must be an HTTPS origin on the default port");
process.stdout.write("deployment environment references validated\n");
