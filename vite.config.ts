import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { DEFAULT_SERVER_PORT } from "./shared/config";

const apiPort = process.env.GRIMOIRE_API_PORT ?? String(DEFAULT_SERVER_PORT);

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": `http://127.0.0.1:${apiPort}`,
    },
  },
});
