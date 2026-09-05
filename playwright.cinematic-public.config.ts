import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

export default defineConfig({
  ...base,
  testMatch: /cinematic\.spec\.ts/u,
  webServer: [],
  outputDir: "test-results-public-cinematic",
  projects: [{ name: "public-computer", use: { baseURL: "https://yuenhk.github.io/Bayblad-Simulator/" } }],
});
