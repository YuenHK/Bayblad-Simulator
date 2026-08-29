#!/usr/bin/env node
import { readFileSync } from "node:fs";

const [manifestPath, environmentPath] = process.argv.slice(2);
if (!manifestPath || !environmentPath) throw new Error("usage: verify-release-manifest MANIFEST ENV_FILE");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const environment = {};
for (const line of readFileSync(environmentPath, "utf8").split(/\r?\n/u)) {
  const match = /^([A-Z][A-Z0-9_]*)=(.*)$/u.exec(line);
  if (match) {
    if (Object.hasOwn(environment, match[1])) throw new Error(`duplicate environment key ${match[1]}`);
    environment[match[1]] = match[2];
  }
}
if (manifest.schemaVersion !== 1 || !/^[a-f0-9]{40}$/u.test(manifest.commit ?? "")) throw new Error("release manifest identity invalid");
const images = manifest.images ?? {};
if (images.migration !== images.server) throw new Error("migration image must equal server image");
for (const [key, envName] of [["server", "SERVER_IMAGE"], ["web", "WEB_IMAGE"], ["database", "DATABASE_IMAGE"]]) {
  if (!/^[a-z0-9][a-z0-9._\/-]*@sha256:[a-f0-9]{64}$/u.test(images[key] ?? "") || environment[envName] !== images[key]) throw new Error(`${envName} does not match the signed release manifest`);
}
process.stdout.write("release manifest references verified\n");
