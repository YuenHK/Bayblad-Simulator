import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { startJsonReadyChild, stopChildCleanly } from "./child-process.mjs";

const readyChild = (source) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ["-e", source], { stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.once("data", () => resolve(child)); child.once("error", reject);
});

test("accepts a child that handles SIGTERM and exits zero", async () => {
  const child = await readyChild("process.on('SIGTERM',()=>process.exit(0)); console.log('ready'); setInterval(()=>{},1000)");
  await stopChildCleanly(child, { requestGraceful: async () => false, timeoutMs: 500 });
  assert.equal(child.exitCode, 0);
});

test("kills and fails a child that ignores SIGTERM", async () => {
  const child = await readyChild("process.on('SIGTERM',()=>{}); console.log('ready'); setInterval(()=>{},1000)");
  await assert.rejects(stopChildCleanly(child, { requestGraceful: async () => false, timeoutMs: 50 }), /required SIGKILL/);
  assert.equal(child.signalCode, "SIGKILL");
});

test("validates children that already exited before teardown", async () => {
  const ok = spawn(process.execPath, ["-e", "process.exit(0)"]); await new Promise((resolve) => ok.once("exit", resolve));
  await stopChildCleanly(ok, { requestGraceful: async () => true });
  const bad = spawn(process.execPath, ["-e", "process.exit(7)"]); await new Promise((resolve) => bad.once("exit", resolve));
  await assert.rejects(stopChildCleanly(bad, { requestGraceful: async () => true }), /code=7/);
});

test("ready timeout reaps the child and leaves no live pid", async () => {
  let pid;
  await assert.rejects(async () => {
    const started = startJsonReadyChild({ command: process.execPath, args: ["-e", "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"], options: { stdio: ["ignore", "pipe", "pipe"] }, timeoutMs: 40, onSpawn: (child) => { pid = child.pid; } });
    await started;
  }, /ready timeout|startup and cleanup failed/);
  assert.throws(() => process.kill(pid, 0), /ESRCH/);
});
