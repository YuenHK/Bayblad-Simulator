#!/usr/bin/env node
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const digestPattern = /^sha256:[a-f0-9]{64}$/u, repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/steam-top\/(server|web|database)$/u;
const MAX_BYTES = 64 * 1024 * 1024;
const challengePattern = /^Bearer\s+realm="([^"]+)",service="([^"]+)",scope="([^"]+)"$/u;

async function body(response) {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > MAX_BYTES) throw new Error("registry object too large");
  const value = Buffer.from(await response.arrayBuffer());
  if (value.length > MAX_BYTES) throw new Error("registry object too large");
  return value;
}

export async function fetchGhcrObject({ repository, digest, kind, actor, token, fetcher = fetch }) {
  if (!repositoryPattern.test(repository) || !digestPattern.test(digest) || !["manifest", "blob"].includes(kind) || !actor || !token) throw new Error("registry request identity invalid");
  const endpoint = `https://ghcr.io/v2/${repository}/${kind === "manifest" ? "manifests" : "blobs"}/${digest}`;
  const basic = `Basic ${Buffer.from(`${actor}:${token}`).toString("base64")}`;
  const headers = { authorization: basic, ...(kind === "manifest" ? { accept: "application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json" } : {}) };
  let response = await fetcher(endpoint, { headers, redirect: "error" });
  if (response.status === 401) {
    const match = challengePattern.exec(response.headers.get("www-authenticate") ?? "");
    if (!match) throw new Error("registry authentication challenge invalid");
    const realm = new URL(match[1]); if (realm.origin !== "https://ghcr.io" || match[3] !== `repository:${repository}:pull`) throw new Error("registry authentication scope invalid");
    realm.searchParams.set("service", match[2]); realm.searchParams.set("scope", match[3]);
    const tokenResponse = await fetcher(realm, { headers: { authorization: basic, accept: "application/json" }, redirect: "error" });
    if (!tokenResponse.ok) throw new Error("registry token exchange failed");
    const authorization = (await tokenResponse.json())?.token; if (typeof authorization !== "string" || authorization.length < 16 || authorization.length > 8192) throw new Error("registry bearer token invalid");
    response = await fetcher(endpoint, { headers: { ...headers, authorization: `Bearer ${authorization}` }, redirect: "error" });
  }
  if (!response.ok) throw new Error(`registry object fetch failed (${response.status})`);
  const value = await body(response), actual = `sha256:${createHash("sha256").update(value).digest("hex")}`;
  if (actual !== digest) throw new Error("registry object digest mismatch");
  return value;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [repository, digest, kind, output] = process.argv.slice(2);
  if (!output) throw new Error("usage: fetch-ghcr-object REPOSITORY DIGEST manifest|blob OUTPUT");
  const value = await fetchGhcrObject({ repository, digest, kind, actor: process.env.GITHUB_ACTOR, token: process.env.GITHUB_TOKEN });
  writeFileSync(output, value, { flag: "wx", mode: 0o600 });
  process.stdout.write(`verified ${kind} ${digest}\n`);
}
