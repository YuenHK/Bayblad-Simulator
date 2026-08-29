#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseProductionEnv } from "./production-env.mjs";

export function verifyReleaseManifest(manifest,environment,expectedRepository,expectedCommit) {
if (manifest.schemaVersion !== 1 || manifest.commit !== expectedCommit || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(expectedRepository)) throw new Error("release manifest identity invalid");
const images = manifest.images ?? {};
if (images.migration !== images.server) throw new Error("migration image must equal server image");
for (const [key, envName] of [["server", "SERVER_IMAGE"], ["web", "WEB_IMAGE"], ["database", "DATABASE_IMAGE"]]) {
  if (!new RegExp(`^ghcr\\.io/${expectedRepository.toLowerCase().replace(/[.*+?^${}()|[\]\\]/gu,"\\$&")}/steam-top/[a-z]+@sha256:[a-f0-9]{64}$`,"u").test(images[key] ?? "") || environment[envName] !== images[key]) throw new Error(`${envName} does not match the attested release manifest`);
}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){const [manifestPath, environmentPath, expectedRepository, expectedCommit] = process.argv.slice(2);if (!expectedCommit) throw new Error("usage: verify-release-manifest MANIFEST ENV_FILE EXPECTED_REPOSITORY EXPECTED_COMMIT");verifyReleaseManifest(JSON.parse(readFileSync(manifestPath, "utf8")),parseProductionEnv(readFileSync(environmentPath, "utf8")),expectedRepository,expectedCommit);process.stdout.write("release manifest references verified\n");}
