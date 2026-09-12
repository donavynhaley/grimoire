import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end proof for the mobile pass, in a real Chromium.
 *
 * The unit suite drives the components with synthetic events; these tests hold an emulated
 * phone - touch, device metrics, the lot - against the running app, which is the only place
 * gestures like a long-press lift or a sheet swipe can be trusted. Ports are fixed and
 * off-season so a running dev server is never mistaken for the fixture.
 *
 * The API is started against a directory wiped on the way in, so the first test run can
 * bootstrap the owner and every run starts from the same empty project.
 */
const API_PORT = 5301;
const WEB_PORT = 5302;

export default defineConfig({
  testDir: "tests/e2e",
  outputDir: "test-results/development",
  // Every test signs into the same freshly-bootstrapped project, so they take turns.
  workers: 1,
  fullyParallel: false,
  timeout: 30_000,
  use: {
    baseURL: `http://127.0.0.1:${WEB_PORT}`,
    trace: "retain-on-failure",
  },
  projects: [
    { name: "phone", use: { ...devices["Pixel 7"] } },
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
  ],
  webServer: [
    {
      command: [
        "rm -rf tests/e2e/.data &&",
        "GRIMOIRE_DATABASE=tests/e2e/.data/grimoire.sqlite",
        "GRIMOIRE_PAGES_DIRECTORY=tests/e2e/.data/cards",
        `PORT=${API_PORT} npx tsx server/index.ts`,
      ].join(" "),
      port: API_PORT,
      reuseExistingServer: false,
    },
    {
      command: `GRIMOIRE_API_PORT=${API_PORT} npx vite --host 127.0.0.1 --port ${WEB_PORT} --strictPort`,
      port: WEB_PORT,
      reuseExistingServer: false,
    },
  ],
});
