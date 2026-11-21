import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.E2E_PORT ?? 4310);

// e2e runs against the production build served by the real server
// (npm run build first): same path as the droplet, including the service worker.
export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  workers: 1,
  fullyParallel: false,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    ...devices['Pixel 7'],
    viewport: { width: 390, height: 844 },
  },
  webServer: {
    command: 'node e2e/serve.mjs',
    url: `http://127.0.0.1:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 30_000,
    // the e2e suites pin the one-phone-per-ID rule (off by default on event day)
    env: { E2E_PORT: String(PORT), AH_ONE_PHONE: '1' },
  },
});
