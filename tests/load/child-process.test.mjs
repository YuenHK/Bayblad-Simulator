import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { stopChildCleanly } from "./child-process.mjs";

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
