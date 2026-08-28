import { defineConfig } from "drizzle-kit";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  dialect: "postgresql",
  schema: resolve(projectRoot, "packages/db/src/schema.ts"),
  // drizzle-kit 0.31 prepends `./` while reading snapshots, so its output
  // folder must be relative to the invocation cwd even when config is loaded
  // from packages/db.
  out: relative(process.cwd(), resolve(projectRoot, "drizzle")) || ".",
  dbCredentials: {
    url:
      process.env.DATABASE_URL ??
      // drizzle generate/check only; production must always inject DATABASE_URL.
      "postgresql://localhost/steam_top_schema_generation",
  },
  strict: true,
  verbose: true,
});
