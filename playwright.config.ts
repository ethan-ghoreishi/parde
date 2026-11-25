import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 30_000,
  use: { baseURL: 'http://127.0.0.1:4391/parde/', serviceWorkers: 'block' },
  webServer: { command: 'npm run build && npm run preview -- --host 127.0.0.1', port: 4391, reuseExistingServer: true, timeout: 120_000 },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile-webkit', use: { ...devices['iPhone 14'] } },
  ],
});
