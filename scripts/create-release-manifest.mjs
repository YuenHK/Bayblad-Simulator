#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const commitPattern = /^[a-f0-9]{40}$/u;
const repositoryPattern = /^ghcr\.io\/[a-z0-9_.-]+\/[a-z0-9_.\/-]+$/u;

export function createReleaseManifest({ commit, repository, digests }) {
  if (!commitPattern.test(commit) || !repositoryPattern.test(repository)) throw new Error("release identity is not canonical");
  for (const value of Object.values(digests)) if (!digestPattern.test(value)) throw new Error("release digest is not canonical");
  const server = `${repository}/server@${digests.server}`;
  return Object.freeze({
    schemaVersion: 1,
    commit,
    images: Object.freeze({ server, migration: server, web: `${repository}/web@${digests.web}`, database: `${repository}/database@${digests.database}` }),
  });
}

function metadataDigest(path) {
  const metadata = JSON.parse(readFileSync(path, "utf8"));
  const digest = metadata["containerimage.digest"];
  if (typeof digest !== "string") throw new Error(`missing pushed digest in ${path}`);
  return digest;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [commit, repository, serverMetadata, webMetadata, databaseMetadata, output] = process.argv.slice(2);
  if (!output) throw new Error("usage: create-release-manifest COMMIT REPOSITORY SERVER_METADATA WEB_METADATA DATABASE_METADATA OUTPUT");
  const manifest = createReleaseManifest({ commit, repository, digests: { server: metadataDigest(serverMetadata), web: metadataDigest(webMetadata), database: metadataDigest(databaseMetadata) } });
  writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
}
