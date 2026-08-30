import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const commit = "e".repeat(40); const repository = "school/top";
const hash = (bytes: Buffer) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));
const image = (architecture: "amd64" | "arm64") => ({ mediaType: "application/vnd.oci.image.manifest.v1+json", digest: `sha256:${(architecture === "amd64" ? "a" : "b").repeat(64)}`, size: 123, platform: { os: "linux", architecture } });

type Options = Readonly<{ wrongRoot?: boolean; wrongSubject?: boolean; wrongSource?: boolean; wrongLayerDigest?: boolean; sbomOnly?: boolean; duplicatePlatform?: boolean; dockerIndex?: boolean; swapBody?: boolean; emptyBuilder?: boolean; incompleteSpdx?: boolean }>;
function platformEvidence(architecture: "amd64" | "arm64", options: Options) {
  const subjectDigest = options.wrongSubject && architecture === "arm64" ? "9".repeat(64) : image(architecture).digest.slice(7);
  const sourceRevision = options.wrongSource && architecture === "arm64" ? "0".repeat(40) : commit;
  const provenance = { _type: "https://in-toto.io/Statement/v0.1", subject: [{ name: `pkg:docker/ghcr.io/${repository}/steam-top/server?platform=linux%2F${architecture}`, digest: { sha256: subjectDigest } }], predicateType: "https://slsa.dev/provenance/v0.2", predicate: { builder: { id: options.emptyBuilder ? "" : "https://github.com/docker/build-push-action" }, buildType: "https://mobyproject.org/buildkit@v1", invocation: { configSource: {}, parameters: {}, environment: { platform: `linux/${architecture}` } }, buildConfig: {}, metadata: { buildStartedOn: "2026-08-30T00:00:00Z", buildFinishedOn: "2026-08-30T00:00:01Z", completeness: { parameters: true, environment: true, materials: true }, reproducible: false, "https://mobyproject.org/buildkit@v1#metadata": { vcs: { source: `https://github.com/${repository}.git`, revision: sourceRevision } } }, materials: [] } };
  const completeSpdx = { SPDXID: "SPDXRef-DOCUMENT", spdxVersion: "SPDX-2.3", dataLicense: "CC0-1.0", name: `steam-top-${architecture}`, documentNamespace: `https://example.invalid/spdx/${architecture}`, creationInfo: { created: "2026-08-30T00:00:01Z", creators: ["Tool: buildkit"] } };
  const sbom = { _type: "https://in-toto.io/Statement/v0.1", subject: [{ name: "_", digest: { sha256: image(architecture).digest.slice(7) } }], predicateType: "https://spdx.dev/Document", predicate: options.incompleteSpdx ? { SPDXID: "SPDXRef-DOCUMENT", spdxVersion: "SPDX-2.3", creationInfo: { creators: ["Tool: buildkit"] } } : completeSpdx };
  const provenanceBytes = bytes(options.swapBody && architecture === "arm64" ? { ...provenance, predicate: { ...provenance.predicate, invocation: { environment: { platform: "linux/amd64" } } } } : provenance);
  const sbomBytes = bytes(sbom);
  const layers = [
    { mediaType: "application/vnd.in-toto+json", digest: options.wrongLayerDigest && architecture === "amd64" ? `sha256:${"9".repeat(64)}` : hash(provenanceBytes), size: provenanceBytes.length, annotations: { "in-toto.io/predicate-type": provenance.predicateType } },
    ...(!options.sbomOnly ? [{ mediaType: "application/vnd.in-toto+json", digest: hash(sbomBytes), size: sbomBytes.length, annotations: { "in-toto.io/predicate-type": sbom.predicateType } }] : []),
  ];
  const manifest = { schemaVersion: 2, mediaType: "application/vnd.oci.image.manifest.v1+json", artifactType: "application/vnd.docker.attestation.manifest.v1+json", subject: { mediaType: image(architecture).mediaType, digest: image(architecture).digest, size: image(architecture).size }, config: { mediaType: "application/vnd.oci.empty.v1+json", digest: `sha256:${"f".repeat(64)}`, size: 2 }, layers };
  const manifestBytes = bytes(manifest);
  const descriptor = { mediaType: manifest.mediaType, digest: hash(manifestBytes), size: manifestBytes.length, annotations: { "vnd.docker.reference.type": "attestation-manifest", "vnd.docker.reference.digest": image(architecture).digest }, platform: { os: "unknown", architecture: "unknown" } };
  return { manifestBytes, provenanceBytes, sbomBytes, descriptor };
}

function fixture(options: Options = {}) {
  const root = mkdtempSync(join(tmpdir(), "multiarch-image-")); roots.push(root);
  const amd64 = platformEvidence("amd64", options), arm64 = platformEvidence("arm64", options);
  const index = { schemaVersion: 2, mediaType: options.dockerIndex ? "application/vnd.docker.distribution.manifest.list.v2+json" : "application/vnd.oci.image.index.v1+json", manifests: [image("amd64"), amd64.descriptor, image("arm64"), arm64.descriptor, ...(options.duplicatePlatform ? [image("amd64")] : [])] };
  const raw = bytes(index); const metadata = { "containerimage.digest": options.wrongRoot ? `sha256:${"8".repeat(64)}` : hash(raw) };
  const paths = ["metadata", "index", "amd64-attestation", "amd64-provenance", "amd64-sbom", "arm64-attestation", "arm64-provenance", "arm64-sbom"].map(name => join(root, `${name}.json`));
  [bytes(metadata), raw, amd64.manifestBytes, amd64.provenanceBytes, amd64.sbomBytes, arm64.manifestBytes, arm64.provenanceBytes, arm64.sbomBytes].forEach((value, index) => writeFileSync(paths[index]!, value));
  const output = join(root, "evidence.json");
  return { output, run: () => execFileSync(process.execPath, ["scripts/verify-multiarch-image.mjs", ...paths, commit, repository, output], { stdio: "pipe" }) };
}

describe("multi-platform release image verifier", () => {
  it.each([false, true])("binds OCI/Docker index, raw attestation statements and source identity (docker=%s)", (dockerIndex) => { const f = fixture({ dockerIndex }); expect(f.run).not.toThrow(); expect(JSON.parse(readFileSync(f.output, "utf8"))).toMatchObject({ schemaVersion: 2, rootDigest: expect.stringMatching(/^sha256:/), platforms: { amd64: { attestationDigest: expect.stringMatching(/^sha256:/), provenance: { predicateType: "https://slsa.dev/provenance/v0.2", layerDigest: expect.stringMatching(/^sha256:/) }, sbom: { predicateType: "https://spdx.dev/Document", layerDigest: expect.stringMatching(/^sha256:/) } }, arm64: { imageDigest: expect.stringMatching(/^sha256:/) } } }); });
  it.each([
    ["root digest", { wrongRoot: true }], ["in-toto subject", { wrongSubject: true }], ["source revision", { wrongSource: true }], ["layer digest", { wrongLayerDigest: true }], ["missing SBOM", { sbomOnly: true }], ["duplicate platform", { duplicatePlatform: true }], ["platform body swap", { swapBody: true }], ["empty SLSA builder", { emptyBuilder: true }], ["incomplete SPDX document", { incompleteSpdx: true }],
  ] as const)("rejects %s mismatch", (_name, options) => expect(fixture(options).run).toThrow());
});
