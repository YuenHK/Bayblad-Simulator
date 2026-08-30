import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const digest = (character: string) => `sha256:${character.repeat(64)}`;
const commit = "e".repeat(40);
const image = (architecture: "amd64" | "arm64") => ({ mediaType: "application/vnd.oci.image.manifest.v1+json", digest: digest(architecture === "amd64" ? "a" : "b"), size: 123, platform: { os: "linux", architecture } });
const attestationDescriptor = (architecture: "amd64" | "arm64") => ({ mediaType: "application/vnd.oci.image.manifest.v1+json", digest: digest(architecture === "amd64" ? "c" : "d"), size: 456, annotations: { "vnd.docker.reference.type": "attestation-manifest", "vnd.docker.reference.digest": image(architecture).digest }, platform: { os: "unknown", architecture: "unknown" } });
const attestationManifest = (architecture: "amd64" | "arm64") => ({ schemaVersion: 2, mediaType: "application/vnd.oci.image.manifest.v1+json", artifactType: "application/vnd.docker.attestation.manifest.v1+json", subject: { mediaType: image(architecture).mediaType, digest: image(architecture).digest, size: image(architecture).size }, config: { mediaType: "application/vnd.oci.empty.v1+json", digest: digest("f"), size: 2 }, layers: [
  { mediaType: "application/vnd.in-toto+json", digest: digest("1"), size: 100, annotations: { "in-toto.io/predicate-type": "https://slsa.dev/provenance/v0.2" } },
  { mediaType: "application/vnd.in-toto+json", digest: digest("2"), size: 100, annotations: { "in-toto.io/predicate-type": "https://spdx.dev/Document" } },
] });
const provenance = (architecture: "amd64" | "arm64") => ({ builder: { id: "https://github.com/moby/buildkit" }, buildType: "https://mobyproject.org/buildkit@v1", materials: [{ uri: "git+https://github.com/school/top.git", digest: { sha1: commit } }], invocation: { environment: { platform: `linux/${architecture}` } } });
const sbom = { SPDXID: "SPDXRef-DOCUMENT", spdxVersion: "SPDX-2.3", creationInfo: { creators: ["Tool: buildkit"] } };

function fixture(mutate?: (value: Record<string, unknown>) => void) {
  const root = mkdtempSync(join(tmpdir(), "multiarch-image-")); roots.push(root);
  const index = { schemaVersion: 2, mediaType: "application/vnd.oci.image.index.v1+json", manifests: [image("amd64"), attestationDescriptor("amd64"), image("arm64"), attestationDescriptor("arm64")] };
  const raw = Buffer.from(JSON.stringify(index));
  const value: Record<string, unknown> = { metadata: { "containerimage.digest": `sha256:${createHash("sha256").update(raw).digest("hex")}` }, raw, index, amd64Attestation: attestationManifest("amd64"), arm64Attestation: attestationManifest("arm64"), amd64Provenance: provenance("amd64"), arm64Provenance: provenance("arm64"), amd64Sbom: sbom, arm64Sbom: sbom };
  mutate?.(value);
  const paths = ["metadata", "index", "amd64-attestation", "amd64-provenance", "amd64-sbom", "arm64-attestation", "arm64-provenance", "arm64-sbom"].map(name => join(root, `${name}.json`));
  const values = [value.metadata, value.raw, value.amd64Attestation, value.amd64Provenance, value.amd64Sbom, value.arm64Attestation, value.arm64Provenance, value.arm64Sbom];
  values.forEach((entry, i) => writeFileSync(paths[i]!, Buffer.isBuffer(entry) ? entry : JSON.stringify(entry)));
  const output = join(root, "evidence.json");
  return { output, run: () => execFileSync(process.execPath, ["scripts/verify-multiarch-image.mjs", ...paths, commit, output], { stdio: "pipe" }) };
}

describe("multi-platform release image verifier", () => {
  it("binds immutable metadata, two platform manifests, real provenance and SPDX evidence", () => { const f = fixture(); expect(f.run).not.toThrow(); expect(JSON.parse(readFileSync(f.output, "utf8"))).toMatchObject({ schemaVersion: 1, rootDigest: expect.stringMatching(/^sha256:/), platforms: { amd64: { provenance: "slsa-v0.2", sbom: "spdx" }, arm64: { provenance: "slsa-v0.2", sbom: "spdx" } } }); });
  it("rejects a metadata/index digest mismatch", () => { const f = fixture(v => { v.metadata = { "containerimage.digest": digest("9") }; }); expect(f.run).toThrow(); });
  it("rejects an attestation whose subject is not its platform manifest", () => { const f = fixture(v => { (v.arm64Attestation as any).subject.digest = digest("9"); }); expect(f.run).toThrow(); });
  it("rejects SBOM-only evidence impersonating provenance", () => { const f = fixture(v => { (v.amd64Attestation as any).layers = [(v.amd64Attestation as any).layers[1]]; }); expect(f.run).toThrow(); });
  it("rejects provenance that does not bind the source commit", () => { const f = fixture(v => { (v.arm64Provenance as any).materials[0].digest.sha1 = "0".repeat(40); }); expect(f.run).toThrow(); });
  it("rejects duplicate or unreviewed descriptors", () => { const f = fixture(v => { const i = v.index as any; i.manifests.push(image("amd64")); v.raw = Buffer.from(JSON.stringify(i)); v.metadata = { "containerimage.digest": `sha256:${createHash("sha256").update(v.raw as Buffer).digest("hex")}` }; }); expect(f.run).toThrow(); });
});
