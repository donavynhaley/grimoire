import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { DEFAULT_SERVER_PORT } from "./shared/config.ts";

const apiPort = process.env.GRIMOIRE_API_PORT ?? String(DEFAULT_SERVER_PORT);

export default defineConfig({
  plugins: [react()],
  // The deferred editor is ~510 kB; initial static closures have stricter enforced budgets.
  build: { manifest: true, chunkSizeWarningLimit: 550 },
  server: {
    proxy: {
      "/api": `http://127.0.0.1:${apiPort}`,
    },
  },
});
