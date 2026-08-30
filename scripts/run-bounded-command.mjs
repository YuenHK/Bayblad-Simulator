#!/usr/bin/env node
import { spawn } from "node:child_process";

const separator = process.argv.indexOf("--");
const timeoutFlag = process.argv.indexOf("--timeout-ms");
const timeoutMs = Number(process.argv[timeoutFlag + 1]);
if (timeoutFlag !== 2 || separator !== 4 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || process.argv.length < 6) {
  console.error("usage: run-bounded-command.mjs --timeout-ms <milliseconds> -- <command> [args...]");
  process.exit(64);
}

const [command, ...args] = process.argv.slice(separator + 1);
const grouped = process.platform !== "win32";
const child = spawn(command, args, { detached: grouped, stdio: "inherit" });
let outcome = null;
let forceTimer = null;

const terminate = (signal) => {
  if (!child.pid) return;
  try {
    if (grouped) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
};

const groupAlive = () => {
  if (!child.pid) return false;
  try {
    if (grouped) process.kill(-child.pid, 0);
    else process.kill(child.pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
};

const beginTermination = (code, signal, diagnostic) => {
  if (outcome) return;
  outcome = { code, signal };
  clearTimeout(timer);
  if (diagnostic) console.error(diagnostic);
  terminate(signal);
  forceTimer = setTimeout(() => {
    if (groupAlive()) terminate("SIGKILL");
    setTimeout(() => process.exit(outcome.code), 25);
  }, 750);
};

const timer = setTimeout(() => {
  beginTermination(124, "SIGTERM", `command exceeded ${timeoutMs}ms; terminating process group`);
}, timeoutMs);

for (const [signal, number] of [["SIGHUP", 1], ["SIGINT", 2], ["SIGTERM", 15]]) {
  process.once(signal, () => {
    beginTermination(128 + number, signal);
  });
}

child.once("error", (error) => {
  clearTimeout(timer);
  console.error(`command could not start: ${error.message}`);
  process.exit(127);
});

child.once("close", (code, signal) => {
  clearTimeout(timer);
  if (outcome) {
    if (!groupAlive()) {
      clearTimeout(forceTimer);
      process.exit(outcome.code);
    }
    return;
  }
  if (signal) process.exit(1);
  process.exit(code ?? 1);
});
