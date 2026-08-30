#!/usr/bin/env node
import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const digestPattern = /^sha256:[a-f0-9]{64}$/u, commitPattern = /^[a-f0-9]{40}$/u, repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const indexMediaTypes = new Set(["application/vnd.oci.image.index.v1+json", "application/vnd.docker.distribution.manifest.list.v2+json"]);
const manifestMediaTypes = new Set(["application/vnd.oci.image.manifest.v1+json", "application/vnd.docker.distribution.manifest.v2+json"]);
const sha = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const same = (left, right) => typeof left === "string" && typeof right === "string" && left.length === right.length && timingSafeEqual(Buffer.from(left), Buffer.from(right));
const parse = (raw, label) => { try { return JSON.parse(raw.toString("utf8")); } catch { throw new Error(`${label} is not JSON`); } };
const descriptor = (value) => value && manifestMediaTypes.has(value.mediaType) && digestPattern.test(value.digest) && Number.isSafeInteger(value.size) && value.size > 0;

function exactSubject(statement, application, label) {
  if (!Array.isArray(statement.subject) || statement.subject.length !== 1 || typeof statement.subject[0]?.name !== "string" || Object.keys(statement.subject[0]?.digest ?? {}).length !== 1 || !same(statement.subject[0].digest.sha256, application.digest.slice(7))) throw new Error(`${label} subject mismatch`);
}

function exactVcs(predicate, expectedCommit, expectedRepository, architecture) {
  const metadata = predicate?.metadata?.["https://mobyproject.org/buildkit@v1#metadata"], vcs = metadata?.vcs;
  const sources = new Set([`https://github.com/${expectedRepository}`, `https://github.com/${expectedRepository}.git`, `git@github.com:${expectedRepository}.git`]);
  return predicate?.buildType === "https://mobyproject.org/buildkit@v1" && typeof predicate.builder?.id === "string" && predicate.invocation?.environment?.platform === `linux/${architecture}` && sources.has(vcs?.source) && same(vcs?.revision, expectedCommit);
}

function verifyLayer(raw, layer, application, expectedType, label) {
  if (!layer || layer.mediaType !== "application/vnd.in-toto+json" || layer.annotations?.["in-toto.io/predicate-type"] !== expectedType || !same(sha(raw), layer.digest) || raw.length !== layer.size) throw new Error(`${label} layer digest or size mismatch`);
  const statement = parse(raw, label);
  if (statement._type !== "https://in-toto.io/Statement/v0.1" || statement.predicateType !== expectedType || !statement.predicate || typeof statement.predicate !== "object") throw new Error(`${label} in-toto statement invalid`);
  exactSubject(statement, application, label);
  return statement;
}

function verifyAttestation(rawManifest, descriptorInIndex, application, rawProvenance, rawSbom, architecture, expectedCommit, expectedRepository) {
  if (!same(sha(rawManifest), descriptorInIndex.digest) || rawManifest.length !== descriptorInIndex.size) throw new Error(`${architecture} attestation descriptor mismatch`);
  const manifest = parse(rawManifest, `${architecture} attestation`);
  if (manifest.schemaVersion !== 2 || manifest.mediaType !== "application/vnd.oci.image.manifest.v1+json" || manifest.artifactType !== "application/vnd.docker.attestation.manifest.v1+json" || !descriptor(manifest.subject) || manifest.subject.digest !== application.digest || manifest.subject.mediaType !== application.mediaType || manifest.subject.size !== application.size || !Array.isArray(manifest.layers)) throw new Error(`${architecture} attestation manifest invalid`);
  const byType = new Map();
  for (const layer of manifest.layers) { const type = layer?.annotations?.["in-toto.io/predicate-type"]; if (typeof type !== "string" || byType.has(type)) throw new Error(`${architecture} duplicate predicate`); byType.set(type, layer); }
  if (byType.size !== 2 || !byType.has("https://slsa.dev/provenance/v0.2") || !byType.has("https://spdx.dev/Document")) throw new Error(`${architecture} exact provenance and SBOM required`);
  const provenance = verifyLayer(rawProvenance, byType.get("https://slsa.dev/provenance/v0.2"), application, "https://slsa.dev/provenance/v0.2", `${architecture} provenance`);
  if (!exactVcs(provenance.predicate, expectedCommit, expectedRepository, architecture)) throw new Error(`${architecture} source provenance mismatch`);
  const sbom = verifyLayer(rawSbom, byType.get("https://spdx.dev/Document"), application, "https://spdx.dev/Document", `${architecture} SBOM`);
  if (sbom.predicate.SPDXID !== "SPDXRef-DOCUMENT" || !/^SPDX-2\.[23]$/u.test(sbom.predicate.spdxVersion) || !Array.isArray(sbom.predicate.creationInfo?.creators) || sbom.predicate.creationInfo.creators.length < 1) throw new Error(`${architecture} SPDX document invalid`);
  return Object.freeze({ imageDigest: application.digest, attestationDigest: descriptorInIndex.digest, provenance: Object.freeze({ predicateType: provenance.predicateType, layerDigest: sha(rawProvenance), documentSha256: sha(rawProvenance).slice(7) }), sbom: Object.freeze({ predicateType: sbom.predicateType, layerDigest: sha(rawSbom), documentSha256: sha(rawSbom).slice(7) }) });
}

export function verifyMultiarchImage(input) {
  const { metadata, rawIndex, expectedCommit, expectedRepository } = input;
  if (!commitPattern.test(expectedCommit) || !repositoryPattern.test(expectedRepository)) throw new Error("expected source identity invalid");
  const expectedRoot = metadata?.["containerimage.digest"], actualRoot = sha(rawIndex);
  if (!digestPattern.test(expectedRoot) || !same(expectedRoot, actualRoot)) throw new Error("metadata/index digest mismatch");
  const index = parse(rawIndex, "multiarch image index");
  if (index.schemaVersion !== 2 || !indexMediaTypes.has(index.mediaType) || !Array.isArray(index.manifests)) throw new Error("multiarch image index invalid");
  const applications = new Map(), attestations = new Map();
  for (const item of index.manifests) {
    if (!descriptor(item)) throw new Error("multiarch descriptor invalid"); const platform = item.platform, annotations = item.annotations;
    if (platform?.os === "linux" && ["amd64", "arm64"].includes(platform.architecture) && Object.keys(platform).every((key) => ["os", "architecture"].includes(key))) { if (applications.has(platform.architecture)) throw new Error("duplicate application platform"); applications.set(platform.architecture, item); continue; }
    if (platform?.os === "unknown" && platform.architecture === "unknown" && annotations?.["vnd.docker.reference.type"] === "attestation-manifest" && digestPattern.test(annotations?.["vnd.docker.reference.digest"])) { const subject = annotations["vnd.docker.reference.digest"]; if (attestations.has(subject)) throw new Error("duplicate platform attestation"); attestations.set(subject, item); continue; }
    throw new Error("unreviewed image platform");
  }
  if (applications.size !== 2 || attestations.size !== 2) throw new Error("required release platforms or attestations missing");
  const verify = (architecture) => { const app = applications.get(architecture), attestation = attestations.get(app?.digest); if (!app || !attestation) throw new Error(`${architecture} evidence missing`); return verifyAttestation(input[`${architecture}Attestation`], attestation, app, input[`${architecture}Provenance`], input[`${architecture}Sbom`], architecture, expectedCommit, expectedRepository); };
  return Object.freeze({ schemaVersion: 2, rootDigest: actualRoot, platforms: Object.freeze({ amd64: verify("amd64"), arm64: verify("arm64") }) });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [metadataPath, indexPath, amd64AttestationPath, amd64ProvenancePath, amd64SbomPath, arm64AttestationPath, arm64ProvenancePath, arm64SbomPath, expectedCommit, expectedRepository, output] = process.argv.slice(2);
  if (!output) throw new Error("usage: verify-multiarch-image METADATA RAW_INDEX AMD64_ATTEST AMD64_PROVENANCE AMD64_SBOM ARM64_ATTEST ARM64_PROVENANCE ARM64_SBOM EXPECTED_COMMIT EXPECTED_REPOSITORY OUTPUT");
  const raw = (path) => readFileSync(path), json = (path) => parse(raw(path), path);
  const evidence = verifyMultiarchImage({ metadata: json(metadataPath), rawIndex: raw(indexPath), amd64Attestation: raw(amd64AttestationPath), amd64Provenance: raw(amd64ProvenancePath), amd64Sbom: raw(amd64SbomPath), arm64Attestation: raw(arm64AttestationPath), arm64Provenance: raw(arm64ProvenancePath), arm64Sbom: raw(arm64SbomPath), expectedCommit, expectedRepository });
  writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  process.stdout.write("immutable amd64 and arm64 release evidence verified\n");
}
