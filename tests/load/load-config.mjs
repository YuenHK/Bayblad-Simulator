function finitePositive(env, name, fallback, { integer = false, minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = env[name] ?? String(fallback), value = Number(raw);
  if (!Number.isFinite(value) || value <= 0 || (integer && !Number.isSafeInteger(value)) || value < minimum || value > maximum) {
    throw new Error(`${name} must be a finite positive${integer ? " safe integer" : " number"} between ${minimum} and ${maximum}; received ${raw}`);
  }
  return value;
}
export function readLoadConfig(env = process.env) {
  return Object.freeze({
    cycles: finitePositive(env, "LOAD_CYCLES", 3, { integer: true, minimum: 3, maximum: 20 }),
    maxScenarioMs: finitePositive(env, "LOAD_MAX_SCENARIO_MS", 60_000, { minimum: 1_000, maximum: 600_000 }),
    heapSpanBytes: finitePositive(env, "LOAD_MAX_STEADY_HEAP_SPAN_MIB", 24, { minimum: 1, maximum: 512 }) * 1024 * 1024,
    linearStepBytes: finitePositive(env, "LOAD_LINEAR_HEAP_STEP_MIB", 4, { minimum: 0.5, maximum: 128 }) * 1024 * 1024,
    readyTimeoutMs: finitePositive(env, "LOAD_READY_TIMEOUT_MS", 15_000, { integer: true, minimum: 100, maximum: 120_000 }),
    shutdownTimeoutMs: finitePositive(env, "LOAD_SHUTDOWN_TIMEOUT_MS", 5_000, { integer: true, minimum: 100, maximum: 30_000 }),
  });
}
