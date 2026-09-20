import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/handoff', timeout: 90_000, workers: 1,
  use: { baseURL: 'http://127.0.0.1:4178/steam-top/', viewport: { width: 1280, height: 980 }, screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  webServer: { command: 'node tests/support/shapecut-static-server.mjs', url: 'http://127.0.0.1:4178/steam-top/', reuseExistingServer: false },
});
