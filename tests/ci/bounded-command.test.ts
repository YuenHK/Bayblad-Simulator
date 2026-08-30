import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const runner = "scripts/run-bounded-command.mjs";

it("returns the child status and output", () => {
  const result = spawnSync(process.execPath, [runner, "--timeout-ms", "1000", "--", process.execPath, "-e", "console.log('done')"], { encoding: "utf8" });
  expect(result.status).toBe(0);
  expect(result.stdout).toMatch(/done/);
});

it("fails quickly with a clear diagnostic when the child stalls", () => {
  const started = Date.now();
  const result = spawnSync(process.execPath, [runner, "--timeout-ms", "100", "--", process.execPath, "-e", "setInterval(()=>{},1000)"], { encoding: "utf8", timeout: 3000 });
  expect(result.status).toBe(124);
  expect(result.stderr).toMatch(/exceeded 100ms/);
  expect(Date.now() - started).toBeLessThan(2500);
});

it("bounds web Vitest and keeps worker usage deterministic", () => {
  const command = JSON.parse(readFileSync("apps/web/package.json", "utf8")).scripts.test;
  expect(command).toContain("run-bounded-command.mjs --timeout-ms 60000");
  expect(command).toContain("vitest run --maxWorkers=1 --no-file-parallelism");
});
