#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const commitPattern = /^[a-f0-9]{40}$/u;
const indexMediaTypes = new Set(["application/vnd.oci.image.index.v1+json", "application/vnd.docker.distribution.manifest.list.v2+json"]);
const manifestMediaTypes = new Set(["application/vnd.oci.image.manifest.v1+json", "application/vnd.docker.distribution.manifest.v2+json"]);
const slsaTypes = new Set(["https://slsa.dev/provenance/v0.2", "https://slsa.dev/provenance/v1"]);
const canonical = (value) => `${JSON.stringify(value, null, 2)}\n`;

function descriptor(value) {
  return value && manifestMediaTypes.has(value.mediaType) && digestPattern.test(value.digest) && Number.isSafeInteger(value.size) && value.size > 0;
}

function containsExactString(value, expected, seen = new Set()) {
  if (value === expected) return true;
  if (!value || typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  return Object.values(value).some((entry) => containsExactString(entry, expected, seen));
}

function verifyAttestation(manifest, application, provenance, sbom, architecture, expectedCommit) {
  if (!manifest || manifest.schemaVersion !== 2 || manifest.mediaType !== "application/vnd.oci.image.manifest.v1+json" || manifest.artifactType !== "application/vnd.docker.attestation.manifest.v1+json") throw new Error(`${architecture} attestation manifest invalid`);
  if (!descriptor(manifest.subject) || manifest.subject.digest !== application.digest || manifest.subject.mediaType !== application.mediaType || manifest.subject.size !== application.size) throw new Error(`${architecture} attestation subject mismatch`);
  if (!Array.isArray(manifest.layers) || manifest.layers.length < 2) throw new Error(`${architecture} attestation layers missing`);
  const predicates = new Set();
  for (const layer of manifest.layers) {
    if (!layer || layer.mediaType !== "application/vnd.in-toto+json" || !digestPattern.test(layer.digest) || !Number.isSafeInteger(layer.size) || layer.size <= 0) throw new Error(`${architecture} attestation layer invalid`);
    const predicate = layer.annotations?.["in-toto.io/predicate-type"];
    if (typeof predicate !== "string" || predicates.has(predicate)) throw new Error(`${architecture} duplicate or malformed predicate`);
    predicates.add(predicate);
  }
  if (![...slsaTypes].some((type) => predicates.has(type)) || !predicates.has("https://spdx.dev/Document")) throw new Error(`${architecture} provenance or SBOM layer missing`);
  if (!provenance || typeof provenance.builder?.id !== "string" || provenance.buildType !== "https://mobyproject.org/buildkit@v1" || provenance.invocation?.environment?.platform !== `linux/${architecture}` || !containsExactString(provenance, expectedCommit)) throw new Error(`${architecture} SLSA provenance invalid`);
  if (!sbom || sbom.SPDXID !== "SPDXRef-DOCUMENT" || !/^SPDX-2\.[23]$/u.test(sbom.spdxVersion) || !Array.isArray(sbom.creationInfo?.creators) || sbom.creationInfo.creators.length < 1) throw new Error(`${architecture} SPDX SBOM invalid`);
  return Object.freeze({ digest: application.digest, provenance: predicates.has("https://slsa.dev/provenance/v1") ? "slsa-v1" : "slsa-v0.2", sbom: "spdx" });
}

export function verifyMultiarchImage({ metadata, rawIndex, amd64Attestation, amd64Provenance, amd64Sbom, arm64Attestation, arm64Provenance, arm64Sbom, expectedCommit }) {
  if (!commitPattern.test(expectedCommit)) throw new Error("expected commit invalid");
  const expectedRoot = metadata?.["containerimage.digest"];
  const actualRoot = `sha256:${createHash("sha256").update(rawIndex).digest("hex")}`;
  if (!digestPattern.test(expectedRoot) || expectedRoot !== actualRoot) throw new Error("metadata/index digest mismatch");
  let index; try { index = JSON.parse(rawIndex.toString("utf8")); } catch { throw new Error("multiarch image index is not JSON"); }
  if (!index || index.schemaVersion !== 2 || !indexMediaTypes.has(index.mediaType) || !Array.isArray(index.manifests)) throw new Error("multiarch image index invalid");
  const applications = new Map(); const attestations = new Map();
  for (const item of index.manifests) {
    if (!descriptor(item)) throw new Error("multiarch descriptor invalid");
    const platform = item.platform;
    if (platform?.os === "linux" && (platform.architecture === "amd64" || platform.architecture === "arm64") && Object.keys(platform).every((key) => key === "os" || key === "architecture")) {
      if (applications.has(platform.architecture)) throw new Error("duplicate application platform");
      applications.set(platform.architecture, item); continue;
    }
    const annotations = item.annotations;
    if (platform?.os === "unknown" && platform.architecture === "unknown" && annotations?.["vnd.docker.reference.type"] === "attestation-manifest" && digestPattern.test(annotations?.["vnd.docker.reference.digest"]) && Object.keys(annotations).every((key) => key === "vnd.docker.reference.type" || key === "vnd.docker.reference.digest")) {
      const subject = annotations["vnd.docker.reference.digest"];
      if (attestations.has(subject)) throw new Error("duplicate platform attestation");
      attestations.set(subject, item); continue;
    }
    throw new Error("unreviewed image platform");
  }
  if (applications.size !== 2 || attestations.size !== 2) throw new Error("required release platforms or attestations missing");
  for (const application of applications.values()) if (!attestations.has(application.digest)) throw new Error("unbound platform attestation");
  const amd64 = verifyAttestation(amd64Attestation, applications.get("amd64"), amd64Provenance, amd64Sbom, "amd64", expectedCommit);
  const arm64 = verifyAttestation(arm64Attestation, applications.get("arm64"), arm64Provenance, arm64Sbom, "arm64", expectedCommit);
  return Object.freeze({ schemaVersion: 1, rootDigest: actualRoot, platforms: Object.freeze({ amd64, arm64 }) });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [metadataPath, indexPath, amd64AttestationPath, amd64ProvenancePath, amd64SbomPath, arm64AttestationPath, arm64ProvenancePath, arm64SbomPath, expectedCommit, output] = process.argv.slice(2);
  if (!output) throw new Error("usage: verify-multiarch-image METADATA RAW_INDEX AMD64_ATTEST AMD64_PROVENANCE AMD64_SBOM ARM64_ATTEST ARM64_PROVENANCE ARM64_SBOM EXPECTED_COMMIT OUTPUT");
  const json = (path) => JSON.parse(readFileSync(path, "utf8"));
  const evidence = verifyMultiarchImage({ metadata: json(metadataPath), rawIndex: readFileSync(indexPath), amd64Attestation: json(amd64AttestationPath), amd64Provenance: json(amd64ProvenancePath), amd64Sbom: json(amd64SbomPath), arm64Attestation: json(arm64AttestationPath), arm64Provenance: json(arm64ProvenancePath), arm64Sbom: json(arm64SbomPath), expectedCommit });
  writeFileSync(output, canonical(evidence), { flag: "wx", mode: 0o600 });
  process.stdout.write("immutable amd64 and arm64 release evidence verified\n");
}
