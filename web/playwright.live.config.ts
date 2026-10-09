import { defineConfig, devices } from '@playwright/test'
export default defineConfig({ testDir: './e2e/live', testMatch: '**/*.pw.ts', outputDir: './.cache/playwright-live-results',
  timeout: 60000, workers: 1, fullyParallel: false, forbidOnly: true, retries: 0, reporter: 'line',
  use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 }, trace: 'retain-on-failure', screenshot: 'only-on-failure' } })
