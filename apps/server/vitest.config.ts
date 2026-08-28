import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Server builds emit into dist; exclude them so tests run once from src.
    exclude: ["**/node_modules/**", "**/.git/**", "dist/**"],
  },
});
