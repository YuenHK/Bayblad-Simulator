import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function verify(manifests: unknown[]) {
  const root = mkdtempSync(join(tmpdir(), "multiarch-image-"));
  roots.push(root);
  const input = join(root, "index.json");
  writeFileSync(input, `${JSON.stringify({ schemaVersion: 2, mediaType: "application/vnd.oci.image.index.v1+json", manifests })}\n`);
  return () => execFileSync(process.execPath, ["scripts/verify-multiarch-image.mjs", input], { stdio: "pipe" });
}

const image = (architecture: string) => ({
  mediaType: "application/vnd.oci.image.manifest.v1+json",
  digest: `sha256:${(architecture === "amd64" ? "a" : "b").repeat(64)}`,
  size: 123,
  platform: { os: "linux", architecture },
});
const attestation = (architecture: string) => ({
  mediaType: "application/vnd.oci.image.manifest.v1+json",
  digest: `sha256:${(architecture === "amd64" ? "c" : "d").repeat(64)}`,
  size: 45,
  annotations: {
    "vnd.docker.reference.type": "attestation-manifest",
    "vnd.docker.reference.digest": image(architecture).digest,
  },
  platform: { os: "unknown", architecture: "unknown" },
});

describe("multi-platform release image verifier", () => {
  it("accepts exactly amd64 and arm64 application manifests plus their attestations", () => {
    expect(verify([image("amd64"), attestation("amd64"), image("arm64"), attestation("arm64")])).not.toThrow();
  });
  it("rejects a release missing the Oracle A1 arm64 image", () => {
    expect(verify([image("amd64"), attestation("amd64")])).toThrow();
  });
  it("rejects unreviewed application platforms", () => {
    expect(verify([image("amd64"), image("arm64"), image("s390x")])).toThrow();
  });
});
