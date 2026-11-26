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
    emptyOutDir: true
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
