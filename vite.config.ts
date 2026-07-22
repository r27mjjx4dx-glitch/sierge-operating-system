import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  root: "src/web",
  plugins: [react(), tailwindcss()],
  build: {
    outDir: "../../dist/web",
    emptyOutDir: true,
  },
  server: {
    port: 5180,
    proxy: {
      "/api": {
        // Keep in sync with the server's SIERGE_PORT (config.ts).
        target: `http://127.0.0.1:${process.env.SIERGE_PORT ?? 4680}`,
        changeOrigin: false,
      },
    },
  },
});
