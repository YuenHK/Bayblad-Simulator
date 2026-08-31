import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import type { UserConfig } from "vite";

type BuildEnvironment = Readonly<Record<string, string | undefined>>;

function exactHttpsOrigin(value: string | undefined): string {
  if (!value) throw new Error("VITE_API_BASE_URL is required for the student build");
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" || parsed.origin !== value || parsed.username || parsed.password) throw new Error("VITE_API_BASE_URL must be an exact HTTPS origin");
  return parsed.origin;
}

export function createWebBuildConfig(environment: BuildEnvironment): UserConfig {
  const target = environment.STEAM_TOP_WEB_TARGET;
  if (target !== "student" && target !== "admin") throw new Error("STEAM_TOP_WEB_TARGET must be student or admin");
  let base: string; let apiBase: string;
  if (target === "student") {
    base = environment.STEAM_TOP_PAGES_BASE ?? "";
    if (!/^\/[A-Za-z0-9._-]+\/$/u.test(base)) throw new Error("STEAM_TOP_PAGES_BASE must be one repository path segment with surrounding slashes");
    apiBase = exactHttpsOrigin(environment.VITE_API_BASE_URL);
  } else { base = "/admin/"; apiBase = ""; }
  const entry = fileURLToPath(new URL(`./src/${target}-entry.tsx`, import.meta.url));
  return {
    base,
    build: { manifest: true },
    resolve: { alias: { "@steam-top/build-entry": entry } },
    define: { "import.meta.env.VITE_API_BASE_URL": JSON.stringify(apiBase) },
    ...(environment.TEST_REALTIME_PROXY ? { preview: { proxy: {
      "/api": { target: environment.TEST_REALTIME_PROXY, changeOrigin: false },
      "/socket.io": { target: environment.TEST_REALTIME_PROXY, ws: true, changeOrigin: true },
      "/__test": { target: environment.TEST_REALTIME_PROXY, changeOrigin: false },
    } } } : {}),
    test: { environment: "jsdom", setupFiles: "./src/test/setup.ts" },
  };
}

export default defineConfig(createWebBuildConfig({
  ...process.env,
  STEAM_TOP_WEB_TARGET: process.env.STEAM_TOP_WEB_TARGET ?? "student",
  STEAM_TOP_PAGES_BASE: process.env.STEAM_TOP_PAGES_BASE ?? "/steam-top/",
  VITE_API_BASE_URL: process.env.VITE_API_BASE_URL ?? "https://api.example.invalid",
}));
