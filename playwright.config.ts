import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:4173",
    browserName: "chromium",
    viewport: { width: 1024, height: 768 },
    hasTouch: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    launchOptions: {
      args: [
        "--enable-webgl",
        "--ignore-gpu-blocklist",
        "--use-angle=swiftshader",
      ],
    },
  },
  webServer: [
    {
      command: "NODE_ENV=test TEST_REALTIME_PORT=4174 TEST_CONTROL_SECRET=steam-top-e2e-only pnpm --filter @steam-top/server exec tsx ../../tests/support/realtime-server.ts",
      url: "http://127.0.0.1:4174/health",
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      command: "TEST_REALTIME_PROXY=http://127.0.0.1:4174 pnpm --filter @steam-top/web build && TEST_REALTIME_PROXY=http://127.0.0.1:4174 pnpm --filter @steam-top/web exec vite preview --host 127.0.0.1 --port 4173",
      url: "http://127.0.0.1:4173",
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: "pipe",
      stderr: "pipe",
    },
  ],
});
