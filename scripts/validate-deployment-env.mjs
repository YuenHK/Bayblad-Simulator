import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseProductionEnv } from "./production-env.mjs";

export function validateDeploymentValues(values,baseOnly=false) {
if (!baseOnly) {
  for (const name of ["SERVER_IMAGE", "WEB_IMAGE", "DATABASE_IMAGE"]) {
    if (!/^[a-z0-9][a-z0-9._\/-]*@sha256:[a-f0-9]{64}$/u.test(values[name] ?? "")) throw new Error(`${name} must be repository@sha256:<64 lowercase hex>`);
  }
  if(process.env.DEPLOYMENT_AUTHORIZATION_PURPOSE!=="release-integration") { const ownerUrl=new URL(values.DATABASE_URL??""),appUrl=new URL(values.APP_DATABASE_URL??"");
  if(ownerUrl.username==="steam_top_app"||appUrl.username!=="steam_top_app"||decodeURIComponent(appUrl.password)!==values.APP_DATABASE_PASSWORD||appUrl.hostname!==ownerUrl.hostname||appUrl.pathname!==ownerUrl.pathname||appUrl.searchParams.get("sslmode")!=="require")throw new Error("owner migration and non-owner app database identities must be separate and exact"); }
}
for (const prefix of ["NODE", "POSTGRES", "CADDY"]) {
  const repository = values[`${prefix}_IMAGE_REPOSITORY`] ?? "";
  const digest = values[`${prefix}_IMAGE_DIGEST`] ?? "";
  if (!repository || /[\s@]/u.test(repository)) throw new Error(`${prefix}_IMAGE_REPOSITORY must be a repository without @`);
  if (!/^sha256:[a-f0-9]{64}$/u.test(digest)) throw new Error(`${prefix}_IMAGE_DIGEST must be sha256: followed by 64 lowercase hex characters`);
}
const origin = new URL(values.PUBLIC_ORIGIN ?? "");
const studentOrigin = values.STUDENT_ORIGIN ? new URL(values.STUDENT_ORIGIN) : undefined;
const integration=process.env.DEPLOYMENT_AUTHORIZATION_PURPOSE==="release-integration",validIntegration=integration&&origin.href==="https://steam-top.integration.test:18443/";
if (origin.protocol !== "https:" || (!validIntegration&&origin.port) || origin.pathname !== "/" || origin.search || origin.hash || origin.username || origin.password || (integration&&!validIntegration)) throw new Error("PUBLIC_ORIGIN must be an approved HTTPS origin");
if (studentOrigin && (studentOrigin.protocol !== "https:" || studentOrigin.port || studentOrigin.pathname !== "/" || studentOrigin.search || studentOrigin.hash || studentOrigin.username || studentOrigin.password || studentOrigin.origin === origin.origin)) throw new Error("STUDENT_ORIGIN must be a distinct default-port HTTPS origin");
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){const values = { ...process.env };const baseOnly = process.argv.includes("--base-only");const environmentFile = process.argv.slice(2).find((value) => value !== "--base-only");if (environmentFile) Object.assign(values, parseProductionEnv(readFileSync(environmentFile, "utf8")));validateDeploymentValues(values,baseOnly);process.stdout.write("deployment environment references validated\n");}
