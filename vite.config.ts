import { defineConfig, type ProxyOptions } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

const socketPath = process.env.ASSETNEST_DEV_SOCKET;
const backend: string | ProxyOptions = socketPath
  // http-proxy reads socketPath from target. Keep the browser Host for CSRF checks.
  ? { target: { protocol: "http:", socketPath } }
  : "http://127.0.0.1:3000";

export default defineConfig({
  root: path.resolve(import.meta.dirname, "src/web"),
  plugins: [react(), tailwindcss()],
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/web"),
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          const normalizedId = id.replace(/\\/g, "/");
          if (!normalizedId.includes("/node_modules/")) return undefined;
          if (
            normalizedId.includes("/react/") ||
            normalizedId.includes("/react-dom/") ||
            normalizedId.includes("/react-router/") ||
            normalizedId.includes("/react-router-dom/") ||
            normalizedId.includes("/scheduler/")
          ) {
            return "vendor-react";
          }
          if (normalizedId.includes("/@dnd-kit/")) {
            return "vendor-dnd";
          }
          if (normalizedId.includes("/@tanstack/")) {
            return "vendor-virtual";
          }
          if (normalizedId.includes("/lucide-react/")) {
            return "vendor-icons";
          }
          return undefined;
        }
      }
    }
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "^/api/v1(?:/|\\?|$)": backend,
      "/healthz": backend
    }
  }
});
