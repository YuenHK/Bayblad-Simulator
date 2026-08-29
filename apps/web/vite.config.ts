import { defineConfig } from "vitest/config";

export default defineConfig({
  build: { manifest: true },
  ...(process.env.TEST_REALTIME_PROXY ? { preview: {
    proxy: {
      "/api": { target: process.env.TEST_REALTIME_PROXY, changeOrigin: false },
      "/socket.io": { target: process.env.TEST_REALTIME_PROXY, ws: true, changeOrigin: true },
      "/__test": { target: process.env.TEST_REALTIME_PROXY, changeOrigin: false },
    },
  } } : {}),
  test: {
    environment: "jsdom",
    setupFiles: "./src/test/setup.ts",
  },
});
