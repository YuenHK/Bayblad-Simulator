import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { readLoadConfig } from "./load-config.mjs";

test("requires at least three formal load cycles", () => assert.throws(() => readLoadConfig({ LOAD_CYCLES: "1" }), /LOAD_CYCLES/));
test("rejects NaN, Infinity, zero and negative thresholds", () => {
  for (const [name, value] of [["LOAD_CYCLES", "NaN"], ["LOAD_MAX_SCENARIO_MS", "Infinity"], ["LOAD_MAX_STEADY_HEAP_SPAN_MIB", "0"], ["LOAD_LINEAR_HEAP_STEP_MIB", "-1"]]) {
    assert.throws(() => readLoadConfig({ [name]: value }), new RegExp(name));
  }
});
test("accepts bounded CI overrides without weakening three-cycle coverage", () => assert.equal(readLoadConfig({ LOAD_CYCLES: "3", LOAD_MAX_SCENARIO_MS: "120000" }).cycles, 3));
test("invalid environment exits before the load server can spawn", () => {
  for (const value of ["1", "NaN", "Infinity"]) {
    const run = spawnSync(process.execPath, ["tests/load/spectators.mjs"], { cwd: process.cwd(), env: { ...process.env, LOAD_CYCLES: value }, encoding: "utf8", timeout: 2_000 });
    assert.notEqual(run.status, 0);
    assert.match(`${run.stdout}${run.stderr}`, /LOAD_CYCLES/);
  }
});
