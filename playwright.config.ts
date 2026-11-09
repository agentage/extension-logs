import { defineConfig } from '@playwright/test';

// Against `agentage extension up` (the release images behind the local gateway); E2E_BASE_URL elsewhere.
export default defineConfig({
  testDir: 'src',
  testMatch: '**/*.spec.ts',
  forbidOnly: !!process.env.CI,
  // A retry only records the trace: a test that passes on it still fails the run.
  retries: process.env.CI ? 1 : 0,
  failOnFlakyTests: !!process.env.CI,
  reporter: [['list']],
  use: {
    trace: 'on-first-retry',
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:4280',
    extraHTTPHeaders: { 'x-client-type': 'test' },
  },
});
