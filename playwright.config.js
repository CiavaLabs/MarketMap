import { defineConfig, devices } from "@playwright/test";

const host = "127.0.0.1";
const port = Number(process.env.MARKETMAP_TEST_PORT || 6071);
const baseURL = `http://${host}:${port}`;

export default defineConfig({
  testDir: "./tests/browser",
  testMatch: "**/*.spec.js",
  outputDir: "test-results",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI
    ? [["line"], ["html", { outputFolder: "playwright-report", open: "never" }]]
    : "list",
  expect: {
    timeout: 7_500,
    toHaveScreenshot: {
      animations: "disabled",
      caret: "hide",
      maxDiffPixelRatio: 0.002,
    },
  },
  use: {
    baseURL,
    locale: "en-US",
    timezoneId: "UTC",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "off",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        deviceScaleFactor: 1,
        launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
          ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
          : undefined,
      },
    },
  ],
  webServer: {
    command: "npm run dev",
    url: baseURL,
    env: {
      ...process.env,
      HOST: host,
      PORT: String(port),
      FINNHUB_API_KEY: "",
      MARKET_LOG_LEVEL: "error",
      MARKET_DEV_IMG_SRC: "'self' data: https://mariociavarella.com https://www.mariociavarella.com",
    },
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
