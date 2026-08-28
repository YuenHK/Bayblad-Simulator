import { defineConfig } from "vitest/config";

export default defineConfig({
  build: { manifest: true },
  test: {
    environment: "jsdom",
    setupFiles: "./src/test/setup.ts",
  },
});
