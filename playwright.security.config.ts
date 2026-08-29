import { defineConfig } from "@playwright/test";
import { securityTlsOptions } from "./tests/security/tls-options";

if ((!process.env.SECURITY_HTTP_ORIGIN || !process.env.SECURITY_HTTPS_ORIGIN) && process.env.SECURITY_ALLOW_SKIP !== "1") {
  throw new Error("SECURITY_HTTP_ORIGIN and SECURITY_HTTPS_ORIGIN are required; use SECURITY_ALLOW_SKIP=1 only for an explicit local skip");
}
securityTlsOptions(process.env);

export default defineConfig({
  testDir: "./tests/security",
  testMatch: "headers.spec.ts",
  timeout: 30_000,
  use: {
    ignoreHTTPSErrors: false,
    launchOptions: { args: ["--enable-webgl", "--ignore-gpu-blocklist", "--use-angle=swiftshader"] },
  },
});
