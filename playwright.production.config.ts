import { defineConfig, devices } from "@playwright/test";

/** Exercise actual built imports, including the browser's failed-module cache. */
export default defineConfig({
  testDir: "tests/production",
  outputDir: "test-results/production",
  workers: 1,
  use: { baseURL: "http://127.0.0.1:5303", trace: "retain-on-failure" },
  projects: [
    { name: "phone", use: { ...devices["Pixel 7"] } },
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
  ],
  webServer: {
    command:
      "rm -rf tests/production/.data && NODE_ENV=production PORT=5303 GRIMOIRE_DATABASE=tests/production/.data/grimoire.sqlite GRIMOIRE_PAGES_DIRECTORY=tests/production/.data/pages node server-dist/index.js",
    port: 5303,
    reuseExistingServer: false,
  },
});
