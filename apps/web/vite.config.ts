import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules/react-router-dom") || id.includes("node_modules/react-router")) {
            return "router";
          }
          if (id.includes("node_modules/@tanstack/react-query")) {
            return "query";
          }
          if (id.includes("node_modules/opencc-js/cn2t")) {
            return "opencc-traditional";
          }
          if (id.includes("node_modules/opencc-js/t2cn")) {
            return "opencc-simplified";
          }
          return undefined;
        },
      },
    },
  },
  server: {
    port: 4173,
    host: "127.0.0.1",
    proxy: {
      "/api": {
        target: "http://127.0.0.1:38765",
        changeOrigin: true,
      },
    },
    fs: {
      allow: [".."],
    },
  },
});
