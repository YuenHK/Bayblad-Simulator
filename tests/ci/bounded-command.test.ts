import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

for (const [signal, code] of [["SIGHUP", 129], ["SIGINT", 130], ["SIGTERM", 143]] as const) {
  it(`forwards ${signal} and returns ${code}`, async () => {
    const child = spawn(process.execPath, [runner, "--timeout-ms", "5000", "--", process.execPath, "-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
    await new Promise(resolve => setTimeout(resolve, 100));
    child.kill(signal);
    expect(await new Promise<number|null>(resolve => child.once("close", resolve))).toBe(code);
  });
}

it("kills a stubborn descendant before returning from timeout", () => {
  const pidFile = join(tmpdir(), `bounded-descendant-${process.pid}-${Date.now()}`);
  const program = `const{spawn}=require('child_process'),fs=require('fs');const c=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{detached:false,stdio:'ignore'});fs.writeFileSync(${JSON.stringify(pidFile)},String(c.pid));process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000)`;
  const result = spawnSync(process.execPath, [runner, "--timeout-ms", "100", "--", process.execPath, "-e", program], { encoding: "utf8", timeout: 3000 });
  expect(result.status).toBe(124);
  expect(existsSync(pidFile)).toBe(true);
  const pid = Number(readFileSync(pidFile, "utf8"));
  expect(() => process.kill(pid, 0)).toThrow();
  rmSync(pidFile, { force: true });
});
