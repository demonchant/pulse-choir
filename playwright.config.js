let defineConfig;
try { ({ defineConfig } = await import('@playwright/test')); }
catch { ({ defineConfig } = await import('./e2e/node_modules/@playwright/test/index.mjs')); }

const artifacts = process.env.PLAYWRIGHT_ARTIFACTS || 'artifacts';
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: 1,
  reporter: [['list'], ['html', { outputFolder: `${artifacts}/playwright-report`, open: 'never' }], ['json', { outputFile: `${artifacts}/playwright-results.json` }]],
  outputDir: `${artifacts}/test-results`,
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:3000',
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {},
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    reducedMotion: 'reduce',
    viewport: { width: 1440, height: 1000 },
  },
  timeout: 20_000,
});
