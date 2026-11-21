// Lab 7, M2: end-to-end tests in a real browser against the real server. Playwright builds the
// client and starts the server (which serves client/dist) before the tests, and stops it after.
import { defineConfig, devices } from "@playwright/test";

const PORT = 8796;

export default defineConfig({
  testDir: "e2e",
  timeout: 30_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  use: { baseURL: `http://127.0.0.1:${PORT}`, trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npm run build && node server/src/index.ts",
    url: `http://127.0.0.1:${PORT}/health`,
    env: { PORT: String(PORT), QUIET: "true" },
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
