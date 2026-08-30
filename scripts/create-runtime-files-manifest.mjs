import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

const [rootArg, outputArg] = process.argv.slice(2);
if (!rootArg || !outputArg) throw new Error("root and output required");
const root = resolve(rootArg);
const output = resolve(outputArg);
const fixed = ["Caddyfile", "compose.yaml", "compose.canonical-app.yaml", "compose.release-integration.yaml"];
const trees = ["scripts", "infra/backup", "apps/server/dist/admin", "drizzle"];
const allowed = /\.(?:sh|mjs|js|sql)$/u;
const files = [...fixed];
for (const tree of trees) {
  const walk = (directory) => {
    for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && allowed.test(entry.name)) files.push(path);
      else if (entry.isSymbolicLink()) throw new Error(`runtime symlink forbidden: ${path}`);
    }
  };
  walk(tree);
}
const normalized = [...new Set(files.map((path) => relative(root, resolve(root, path)).split(sep).join("/")))].sort();
for (const path of normalized) if (path.startsWith("../") || path.includes("\n")) throw new Error("unsafe runtime path");
const lines = normalized.map((path) => {
  const absolute = join(root, path);
  if (!statSync(absolute).isFile()) throw new Error(`runtime file missing: ${path}`);
  const digest = createHash("sha256").update(readFileSync(absolute)).digest("hex");
  const mode = path.endsWith(".sh") ? "0555" : "0444";
  return `${digest} ${mode} ${path}`;
});
writeFileSync(output, `${lines.join("\n")}\n`, { flag: "wx", mode: 0o444 });
