import { describe, expect, it } from "vitest";
import { loadConfig, publicConfig } from "./config";

const secret = (character: string) => character.repeat(48);
const validEnvironment = (): NodeJS.ProcessEnv => ({
  NODE_ENV: "production",
  DATABASE_URL: "postgresql://steam_top:password@db:5432/steam_top",
  PUBLIC_ORIGIN: "https://tops.school.example",
  COOKIE_SIGNING_KEY: secret("c"),
  ADMIN_USERNAME: "admin",
  ADMIN_INITIAL_PASSWORD: "fwft2026",
  ADMIN_CSRF_SECRET: secret("a"),
  ADMIN_CSRF_KEY_ID: "primary",
  WEBCLIP_SIGNING_KEY: secret("w"),
  WEBCLIP_EXCHANGE_KEY: secret("x"),
  ANALYTICS_CURSOR_SECRET: secret("q"),
  ICLASS_MODE: "guest-only-explicit",
  DELETION_LEDGER_FILE: "/var/lib/steam-top/deletion-ledger.log",
  DELETION_SOURCE_INSTANCE_ID: "90000000-0000-4000-8000-000000000001",
  DATABASE_TLS: "require",
});

describe("production environment contract", () => {
  it.each(["DATABASE_URL", "COOKIE_SIGNING_KEY", "ADMIN_INITIAL_PASSWORD", "WEBCLIP_SIGNING_KEY"])(
    "refuses to boot without %s",
    (key) => {
      const environment = validEnvironment();
      delete environment[key];
      expect(() => loadConfig(environment)).toThrow(key);
    },
  );

  it("requires HTTPS and production-strength secrets", () => {
    expect(() => loadConfig({ ...validEnvironment(), PUBLIC_ORIGIN: "http://tops.school.example" })).toThrow("PUBLIC_ORIGIN");
    expect(() => loadConfig({ ...validEnvironment(), COOKIE_SIGNING_KEY: "too-short" })).toThrow("COOKIE_SIGNING_KEY");
    expect(() => loadConfig({ ...validEnvironment(), ADMIN_INITIAL_PASSWORD: "short" })).toThrow("ADMIN_INITIAL_PASSWORD");
    expect(() => loadConfig({ ...validEnvironment(), COOKIE_SIGNING_KEY: "!".repeat(48) })).toThrow("base64url");
    expect(() => loadConfig({ ...validEnvironment(), PUBLIC_ORIGIN: "https://tops.school.example:8443" })).toThrow("default HTTPS port");
  });

  it("requires only the inputs selected by the explicit iClass mode", () => {
    expect(() => loadConfig({ ...validEnvironment(), ICLASS_MODE: "api" })).toThrow("ICLASS_API_BEARER_TOKEN");
    expect(() => loadConfig({ ...validEnvironment(), ICLASS_MODE: "csv" })).toThrow("ICLASS_DEVICE_MAP_CSV_PATH");
    const api = { ...validEnvironment(), ICLASS_MODE: "api", ICLASS_API_URL: "https://iclass.example/api", ICLASS_API_BEARER_TOKEN: "token" };
    expect(loadConfig(api).iClassApiBearerToken).toBe("token");
  });

  it("accepts secret files and never exposes secret values in public diagnostics", () => {
    const environment = validEnvironment();
    const values = new Map<string, string>();
    for (const key of ["DATABASE_URL", "COOKIE_SIGNING_KEY", "ADMIN_INITIAL_PASSWORD", "ADMIN_CSRF_SECRET", "WEBCLIP_SIGNING_KEY", "WEBCLIP_EXCHANGE_KEY", "ANALYTICS_CURSOR_SECRET"] as const) {
      values.set(`/run/secrets/${key.toLowerCase()}`, environment[key]!);
      delete environment[key];
      environment[`${key}_FILE`] = `/run/secrets/${key.toLowerCase()}`;
    }
    const config = loadConfig(environment, (path) => values.get(path) ?? "");
    const rendered = JSON.stringify(publicConfig(config));
    for (const value of values.values()) expect(rendered).not.toContain(value);
    expect(publicConfig(config)).toEqual({
      nodeEnv: "production",
      publicOrigin: "https://tops.school.example",
      host: "0.0.0.0",
      port: 3000,
      iClassMode: "guest-only-explicit",
      databaseTls: true,
    });
  });
});
