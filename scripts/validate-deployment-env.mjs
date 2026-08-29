import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseProductionEnv } from "./production-env.mjs";

export function validateDeploymentValues(values,baseOnly=false) {
if (!baseOnly) {
  for (const name of ["SERVER_IMAGE", "WEB_IMAGE", "DATABASE_IMAGE"]) {
    if (!/^[a-z0-9][a-z0-9._\/-]*@sha256:[a-f0-9]{64}$/u.test(values[name] ?? "")) throw new Error(`${name} must be repository@sha256:<64 lowercase hex>`);
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
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){const values = { ...process.env };const baseOnly = process.argv.includes("--base-only");const environmentFile = process.argv.slice(2).find((value) => value !== "--base-only");if (environmentFile) Object.assign(values, parseProductionEnv(readFileSync(environmentFile, "utf8")));validateDeploymentValues(values,baseOnly);process.stdout.write("deployment environment references validated\n");}
