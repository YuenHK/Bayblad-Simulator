import { defineConfig } from "vitest/config";

export default defineConfig({
  build: { rollupOptions: { output: { manualChunks(id) { if (id.includes("/node_modules/three/")) return "three"; if (id.includes("@react-three") || id.includes("/node_modules/@pmndrs/")) return "react-three"; } } } },
  test: {
    environment: "jsdom",
    setupFiles: "./src/test/setup.ts",
  },
});
