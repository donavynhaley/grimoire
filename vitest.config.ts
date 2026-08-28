import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.{ts,tsx}"],
    setupFiles: ["./tests/setup.ts"],
    restoreMocks: true,
    coverage: {
      // Opt-in via `npm run test:coverage`; the plain run stays fast.
      provider: "v8",
      include: ["src/**", "server/**", "shared/**"],
      reporter: ["text-summary", "html"],
    },
  },
});
