const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function stopChildCleanly(child, { requestGraceful, timeoutMs = 5_000, diagnostics = () => "" }) {
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  let requested = false;
  try { requested = await requestGraceful(); } catch { /* SIGTERM fallback */ }
  if (!requested) child.kill("SIGTERM");
  const exit = await Promise.race([exited, delay(timeoutMs).then(() => null)]);
  if (!exit) {
    child.kill("SIGKILL");
    await exited;
    throw new Error(`Child ignored graceful shutdown and required SIGKILL\n${diagnostics()}`);
  }
  child.stdout?.destroy(); child.stderr?.destroy(); child.removeAllListeners();
  if (exit.code !== 0 || exit.signal !== null) throw new Error(`Child teardown was not clean code=${exit.code} signal=${exit.signal}\n${diagnostics()}`);
}
