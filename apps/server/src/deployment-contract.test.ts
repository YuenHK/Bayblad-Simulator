import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const read = (path: string) => readFileSync(`${root}/${path}`, "utf8");

describe("static production deployment contract", () => {
  const compose = read("compose.yaml");

  it("gates server startup on a successful one-shot migration", () => {
    expect(compose).toMatch(/migration:[\s\S]*restart:\s*["']?no["']?/u);
    expect(compose).toMatch(/server:[\s\S]*migration:\s*\{ condition: service_completed_successfully \}/u);
  });

  it("keeps the export temporary filesystem at or above one GiB", () => {
    expect(compose).toMatch(/server:[\s\S]*\/tmp:size=(?:1g|1024m)/iu);
  });

  it("isolates edge, backend and database networks", () => {
    for (const name of ["edge", "backend", "database"]) expect(compose).toContain(`${name}:`);
    expect(compose).toMatch(/db:[\s\S]*networks:\s*\[database\]/u);
    expect(compose).toMatch(/web:[\s\S]*networks:\s*\[edge\]/u);
    expect(compose).toMatch(/server:[\s\S]*networks:\s*\[backend, database\]/u);
  });

  it("requires immutable image references and validates them before deployment", () => {
    expect(compose).toContain("${NODE_IMAGE:?");
    expect(compose).toContain("${POSTGRES_IMAGE:?");
    expect(compose).toContain("${CADDY_IMAGE:?");
    expect(read("scripts/validate-deployment-env.mjs")).toContain("@sha256:");
  });

  it("mounts the safe CSV map read-only at a fixed internal path", () => {
    expect(compose).toContain("/app/config/iclass-device-map.csv:ro");
    expect(read("config/iclass-device-map.csv")).toBe("externalDeviceId,deviceName,studentName,className,studentNumber\n");
  });
});
