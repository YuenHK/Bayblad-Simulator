#!/usr/bin/env node
import { readFileSync } from "node:fs";

const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const indexMediaTypes = new Set([
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
]);
const manifestMediaTypes = new Set([
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
]);

export function verifyMultiarchImage(index) {
  if (!index || index.schemaVersion !== 2 || !indexMediaTypes.has(index.mediaType) || !Array.isArray(index.manifests)) throw new Error("multiarch image index invalid");
  const applications = new Map();
  const attestations = new Map();
  for (const descriptor of index.manifests) {
    if (!descriptor || !manifestMediaTypes.has(descriptor.mediaType) || !digestPattern.test(descriptor.digest) || !Number.isSafeInteger(descriptor.size) || descriptor.size <= 0) throw new Error("multiarch descriptor invalid");
    const platform = descriptor.platform;
    if (platform?.os === "linux" && (platform.architecture === "amd64" || platform.architecture === "arm64") && Object.keys(platform).every(key => key === "os" || key === "architecture")) {
      if (applications.has(platform.architecture)) throw new Error("duplicate application platform");
      applications.set(platform.architecture, descriptor.digest);
      continue;
    }
    const annotations = descriptor.annotations;
    if (platform?.os === "unknown" && platform.architecture === "unknown" && annotations?.["vnd.docker.reference.type"] === "attestation-manifest" && digestPattern.test(annotations?.["vnd.docker.reference.digest"])) {
      const subject = annotations["vnd.docker.reference.digest"];
      if (attestations.has(subject)) throw new Error("duplicate platform attestation");
      attestations.set(subject, descriptor.digest);
      continue;
    }
    throw new Error("unreviewed image platform");
  }
  if (applications.size !== 2 || !applications.has("amd64") || !applications.has("arm64")) throw new Error("required release platforms missing");
  for (const digest of applications.values()) if (!attestations.has(digest)) throw new Error("platform provenance attestation missing");
  if (attestations.size !== applications.size) throw new Error("unbound platform attestation");
  return true;
}

if (process.argv[1] && process.argv[2]) {
  verifyMultiarchImage(JSON.parse(readFileSync(process.argv[2], "utf8")));
  process.stdout.write("amd64 and arm64 release manifests verified\n");
}
