import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

export default defineConfig({
  ...base,
  testMatch: /cinematic\.spec\.ts/u,
  webServer: [],
  outputDir: "test-results-public-cinematic",
  expect: { timeout: 60_000 },
  projects: [{ name: "public-computer", use: { baseURL: "https://yuenhk.github.io/Bayblad-Simulator/" } }],
});
