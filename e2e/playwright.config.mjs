import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.mjs',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 45_000,
  use: {
    browserName: 'chromium',
  },
});
