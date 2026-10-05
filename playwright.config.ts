import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  // One Herald and one database are shared by every test.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  timeout: 90_000,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    screenshot: 'on',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run build && vite build demo --mode e2e && vite preview demo --port 4175 --strictPort',
    url: 'http://localhost:4175',
    reuseExistingServer: false,
    timeout: 120_000,
  },
})
