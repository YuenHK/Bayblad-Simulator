import { describe, expect, it } from "vitest";
import { createReleaseManifest } from "../../scripts/create-release-manifest.mjs";

describe("release image manifest", () => {
  it("accepts only exact pushed digests and binds migration to the server image", () => {
    const digest = (character: string) => `sha256:${character.repeat(64)}`;
    expect(createReleaseManifest({ commit: "a".repeat(40), repository: "ghcr.io/school/top", digests: { server: digest("1"), web: digest("2"), database: digest("3") } })).toEqual({
      schemaVersion: 1,
      commit: "a".repeat(40),
      images: {
        server: `ghcr.io/school/top/server@${digest("1")}`,
        migration: `ghcr.io/school/top/server@${digest("1")}`,
        web: `ghcr.io/school/top/web@${digest("2")}`,
        database: `ghcr.io/school/top/database@${digest("3")}`,
      },
    });
    expect(() => createReleaseManifest({ commit: "branch", repository: "ghcr.io/x/y", digests: { server: "latest", web: digest("2"), database: digest("3") } })).toThrow();
  });
});
