// E2E config. The helpers launch a persistent Chromium context with the unpacked extension,
// so there is no `projects`/browser config here. Build first: `node scripts/build.mjs`.
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'test/e2e',
  workers: 1,
  fullyParallel: false,
  timeout: 60000,
  expect: { timeout: 10000 },
  reporter: 'list',
  retries: 0
});
