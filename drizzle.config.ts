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
      "postgres://steam_top:steam_top@127.0.0.1:5432/steam_top",
  },
  strict: true,
  verbose: true,
});
