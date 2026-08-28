import { spawn } from "node:child_process";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const currentExit = (child) => child.exitCode !== null || child.signalCode !== null ? { code: child.exitCode, signal: child.signalCode } : null;
function cleanup(child) { child.stdout?.destroy(); child.stderr?.destroy(); child.removeAllListeners(); }
function validate(exit, diagnostics) {
  if (exit.code !== 0 || exit.signal !== null) throw new Error(`Child teardown was not clean code=${exit.code} signal=${exit.signal}\n${diagnostics()}`);
}
function waitForExit(child, timeoutMs) {
  const existing = currentExit(child); if (existing) return Promise.resolve(existing);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => { if (settled) return; settled = true; clearTimeout(timer); child.off("exit", onExit); resolve(value); };
    const onExit = (code, signal) => finish({ code, signal });
    const timer = setTimeout(() => finish(null), timeoutMs);
    child.once("exit", onExit);
    const raced = currentExit(child); if (raced) finish(raced);
  });
}

export async function stopChildCleanly(child, { requestGraceful, timeoutMs = 5_000, killTimeoutMs = 2_000, diagnostics = () => "" }) {
  const already = currentExit(child);
  if (already) { cleanup(child); validate(already, diagnostics); return; }
  const settled = waitForExit(child, timeoutMs);
  let requested = false; try { requested = await requestGraceful(); } catch { /* SIGTERM fallback */ }
  if (!requested && !currentExit(child)) child.kill("SIGTERM");
  const exit = await settled;
  if (exit) { cleanup(child); validate(exit, diagnostics); return; }
  child.kill("SIGKILL");
  const killed = await waitForExit(child, killTimeoutMs);
  cleanup(child);
  if (!killed) throw new Error(`Child remained alive after SIGKILL timeout\n${diagnostics()}`);
  throw new Error(`Child ignored graceful shutdown and required SIGKILL\n${diagnostics()}`);
}

export async function startJsonReadyChild({ command, args, options, timeoutMs = 15_000, onSpawn = () => {} }) {
  const child = spawn(command, args, options); let output = "", buffer = "", settled = false;
  onSpawn(child);
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`Child ready timeout after ${timeoutMs}ms`)), timeoutMs);
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(value); };
    child.stdout.on("data", (chunk) => { const text = String(chunk); output += text; buffer += text; for (;;) { const at = buffer.indexOf("\n"); if (at < 0) break; const line = buffer.slice(0, at).trim(); buffer = buffer.slice(at + 1); try { const parsed = JSON.parse(line); if (parsed.type === "ready") finish(null, parsed); } catch { /* diagnostics */ } } });
    child.stderr.on("data", (chunk) => { output += String(chunk); });
    child.once("error", (error) => finish(error));
    child.once("exit", (code, signal) => { if (!settled) finish(new Error(`Child exited before ready code=${code} signal=${signal}`)); });
  });
  try { return { child, info: await ready, output: () => output }; }
  catch (error) {
    try { await stopChildCleanly(child, { requestGraceful: async () => false, timeoutMs: 250, killTimeoutMs: 1_000, diagnostics: () => output }); }
    catch (cleanupError) { if (!currentExit(child)) child.kill("SIGKILL"); throw new AggregateError([error, cleanupError], "Child startup and cleanup failed"); }
    throw error;
  }
}
