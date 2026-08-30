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
let finishing = false;

const terminate = (signal) => {
  if (!child.pid) return;
  try {
    if (grouped) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
};

const timer = setTimeout(() => {
  finishing = true;
  console.error(`command exceeded ${timeoutMs}ms; terminating process group`);
  terminate("SIGTERM");
  const force = setTimeout(() => terminate("SIGKILL"), 750);
  force.unref();
}, timeoutMs);

for (const [signal, number] of [["SIGHUP", 1], ["SIGINT", 2], ["SIGTERM", 15]]) {
  process.once(signal, () => {
    finishing = true;
    clearTimeout(timer);
    terminate(signal);
    setTimeout(() => terminate("SIGKILL"), 750).unref();
    child.once("close", () => process.exit(128 + number));
  });
}

child.once("error", (error) => {
  clearTimeout(timer);
  console.error(`command could not start: ${error.message}`);
  process.exit(127);
});

child.once("close", (code, signal) => {
  clearTimeout(timer);
  if (finishing) process.exit(124);
  if (signal) process.exit(1);
  process.exit(code ?? 1);
});
