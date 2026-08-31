import { defineConfig } from "@playwright/test";

const workspaceHash = [...process.cwd()].reduce((hash, character) => (hash * 33 + character.codePointAt(0)!) % 10_000, 5381);
const portBase = 30_000 + workspaceHash * 2;
const webPort = Number(process.env.E2E_WEB_PORT ?? portBase);
const realtimePort = Number(process.env.E2E_REALTIME_PORT ?? portBase + 1);
const adminPort = Number(process.env.E2E_ADMIN_PORT ?? portBase + 2);
process.env.E2E_WEB_PORT = String(webPort);
process.env.E2E_REALTIME_PORT = String(realtimePort);
process.env.E2E_ADMIN_PORT = String(adminPort);
const webUrl = `http://127.0.0.1:${webPort}`;
const realtimeUrl = `http://127.0.0.1:${realtimePort}`;
const adminUrl = `http://127.0.0.1:${adminPort}`;

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  use: {
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
  projects: [
    { name: "student", testIgnore: /admin\.spec\.ts/u, use: { baseURL: `${webUrl}/steam-top/` } },
    { name: "admin", testMatch: /admin\.spec\.ts/u, use: { baseURL: `${adminUrl}/admin/` } },
  ],
  webServer: [
    {
      command: `NODE_ENV=test BATTLE_ENGINE=deterministic E2E_WEB_PORT=${webPort} E2E_ADMIN_PORT=${adminPort} TEST_REALTIME_PORT=${realtimePort} TEST_CONTROL_SECRET=steam-top-e2e-only pnpm --filter @steam-top/server exec tsx ../../tests/support/realtime-server.ts`,
      url: `${realtimeUrl}/health`,
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      command: `TEST_REALTIME_PROXY=${realtimeUrl} pnpm --filter @steam-top/web build:student && TEST_REALTIME_PROXY=${realtimeUrl} pnpm --filter @steam-top/web exec vite preview --host 127.0.0.1 --port ${webPort}`,
      url: webUrl,
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      command: `STEAM_TOP_WEB_TARGET=admin TEST_REALTIME_PROXY=${realtimeUrl} pnpm --filter @steam-top/web exec vite --host 127.0.0.1 --port ${adminPort}`,
      url: `${adminUrl}/admin/`,
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: "pipe",
      stderr: "pipe",
    },
  ],
});
