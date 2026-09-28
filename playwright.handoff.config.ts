import { defineConfig } from '@playwright/test';
const publicAcceptance = process.env.SHAPECUT_PUBLIC_ACCEPTANCE === '1';
export default defineConfig({
  testDir: './tests/handoff', timeout: 90_000, workers: 1,
  outputDir: publicAcceptance ? 'test-results-public-handoff' : 'test-results',
  use: { baseURL: publicAcceptance ? 'https://yuenhk.github.io/Bayblad-Simulator/' : 'http://127.0.0.1:4178/steam-top/', viewport: { width: 1280, height: 980 }, screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  webServer: publicAcceptance ? [] : { command: 'node tests/support/shapecut-static-server.mjs', url: 'http://127.0.0.1:4178/steam-top/', reuseExistingServer: false },
});
