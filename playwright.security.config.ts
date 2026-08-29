import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/security",
  testMatch: "headers.spec.ts",
  timeout: 30_000,
  use: { ignoreHTTPSErrors: true },
});
