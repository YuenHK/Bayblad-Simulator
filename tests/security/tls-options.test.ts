import { describe, expect, it, vi } from "vitest";
import { securityTlsOptions } from "./tls-options";

describe("security test TLS trust", () => {
  it("keeps certificate verification strict by default", () => {
    expect(securityTlsOptions({ SECURITY_HTTPS_ORIGIN: "https://tops.school.example" })).toEqual({ rejectUnauthorized: true });
  });

  it("loads an explicit local CA and keeps verification enabled", () => {
    const read = vi.fn(() => "-----BEGIN CERTIFICATE-----\nLOCAL_CA\n-----END CERTIFICATE-----\n");
    expect(securityTlsOptions({ SECURITY_HTTPS_ORIGIN: "https://localhost", SECURITY_TLS_CA_FILE: "/run/caddy/pki/ca.crt" }, read)).toEqual({
      ca: "-----BEGIN CERTIFICATE-----\nLOCAL_CA\n-----END CERTIFICATE-----\n",
      rejectUnauthorized: true,
    });
    expect(read).toHaveBeenCalledWith("/run/caddy/pki/ca.crt", "utf8");
  });

  it("rejects every attempt to disable certificate verification", () => {
    expect(() => securityTlsOptions({ SECURITY_HTTPS_ORIGIN: "https://127.0.0.1", SECURITY_TLS_INSECURE: "true" })).toThrow("forbidden");
    expect(() => securityTlsOptions({ SECURITY_HTTPS_ORIGIN: "https://localhost", SECURITY_TLS_INSECURE: "false" })).toThrow("forbidden");
  });

  it("rejects an empty or oversized CA file", () => {
    const env = { SECURITY_HTTPS_ORIGIN: "https://localhost", SECURITY_TLS_CA_FILE: "/tmp/ca.crt" };
    expect(() => securityTlsOptions(env, () => "  ")).toThrow("CA file");
    expect(() => securityTlsOptions(env, () => "x".repeat(1_048_577))).toThrow("CA file");
  });
});
