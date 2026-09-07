import { execFileSync, spawnSync } from "node:child_process";
import { expect, it } from "vitest";

const readWorkflow = (name: string) => JSON.parse(execFileSync("ruby", ["-e",
  "require 'yaml';require 'json';print JSON.generate(YAML.safe_load(File.read(ARGV[0]),aliases:true))",
  `.github/workflows/${name}.yml`,
], { encoding: "utf8" }));

it("provides the reusable workflow's requested token permissions", () => {
  const caller = readWorkflow("authorize-release").jobs.authorize;
  const called = readWorkflow("ci");
  const levels: Record<string, number> = { none: 0, read: 1, write: 2 };
  for (const [name, job] of Object.entries(called.jobs) as [string, any][]) {
    for (const [scope, level] of Object.entries(job.permissions ?? called.permissions)) {
      expect(levels[caller.permissions[scope] ?? "none"], `${name}: ${scope}`)
        .toBeGreaterThanOrEqual(levels[String(level)]!);
    }
  }
});

it("parses every CI bash step, including jobs skipped on ordinary pushes", () => {
  const workflow = readWorkflow("ci");
  for (const [name, job] of Object.entries(workflow.jobs) as [string, any][]) {
    for (const step of job.steps ?? []) {
      if (typeof step.run !== "string" || (step.shell && step.shell !== "bash")) continue;
      // GitHub expressions are expanded before the runner invokes the shell.
      const script = step.run.replace(/\$\{\{[\s\S]*?\}\}/g, "workflow_value");
      const result = spawnSync("bash", ["-n"], { input: script, encoding: "utf8" });
      expect(result.status, `${name}: ${step.name ?? "run"}\n${result.stderr}`).toBe(0);
    }
  }
});
