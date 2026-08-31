import { describe, expect, it } from "vitest";
import { createWebBuildConfig } from "../vite.config";

describe("split web build contract", () => {
  it("creates a student build with an exact Pages base and HTTPS API origin", () => {
    const config = createWebBuildConfig({ STEAM_TOP_WEB_TARGET: "student", STEAM_TOP_PAGES_BASE: "/steam-top/", VITE_API_BASE_URL: "https://tops.duckdns.org" });
    expect(config).toMatchObject({ base: "/steam-top/", resolve: { alias: { "@steam-top/build-entry": expect.stringMatching(/student-entry\.tsx$/) } }, define: { "import.meta.env.VITE_API_BASE_URL": '"https://tops.duckdns.org"' } });
  });
  it("creates an admin build only at the Oracle same-origin admin path", () => {
    const config = createWebBuildConfig({ STEAM_TOP_WEB_TARGET: "admin" });
    expect(config).toMatchObject({ base: "/admin/", resolve: { alias: { "@steam-top/build-entry": expect.stringMatching(/admin-entry\.tsx$/) } }, define: { "import.meta.env.VITE_API_BASE_URL": '""' } });
  });
  it("uses the same-origin proxy only for the explicit local e2e build", () => {
    const config = createWebBuildConfig({ STEAM_TOP_WEB_TARGET: "student", STEAM_TOP_PAGES_BASE: "/steam-top/", VITE_API_BASE_URL: "https://api.example.invalid", TEST_REALTIME_PROXY: "http://127.0.0.1:4174" });
    expect(config).toMatchObject({
      define: { "import.meta.env.VITE_API_BASE_URL": '""' },
      server: { proxy: { "/api": { target: "http://127.0.0.1:4174" } } },
      preview: { proxy: { "/api": { target: "http://127.0.0.1:4174" } } },
    });
  });
  it.each([
    { STEAM_TOP_WEB_TARGET: "student", STEAM_TOP_PAGES_BASE: "/", VITE_API_BASE_URL: "https://tops.duckdns.org" },
    { STEAM_TOP_WEB_TARGET: "student", STEAM_TOP_PAGES_BASE: "/steam-top", VITE_API_BASE_URL: "https://tops.duckdns.org" },
    { STEAM_TOP_WEB_TARGET: "student", STEAM_TOP_PAGES_BASE: "/steam-top/?x=1", VITE_API_BASE_URL: "https://tops.duckdns.org" },
    { STEAM_TOP_WEB_TARGET: "student", STEAM_TOP_PAGES_BASE: "/steam-top/", VITE_API_BASE_URL: "http://tops.duckdns.org" },
    { STEAM_TOP_WEB_TARGET: "student", STEAM_TOP_PAGES_BASE: "/steam-top/", VITE_API_BASE_URL: "https://tops.duckdns.org/path" },
    { STEAM_TOP_WEB_TARGET: "unknown" },
  ])("rejects unsafe or ambiguous build input %#", (environment) => expect(() => createWebBuildConfig(environment)).toThrow());
});
