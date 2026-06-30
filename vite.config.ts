import { defineConfig } from "vite";

// Frontend lives in web/. In dev, Vite serves on 5273 (5173 is a common default
// that often collides with other local Vite apps) and proxies the API + WebSocket
// to the Fastify backend on 4317. In prod, `vite build` emits to web/dist which
// Fastify serves directly (see server/index.ts).
export default defineConfig({
  root: "web",
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    port: 5273,
    proxy: {
      "/api": "http://127.0.0.1:4317",
      "/ws": { target: "ws://127.0.0.1:4317", ws: true },
    },
  },
});
