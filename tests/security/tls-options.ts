import { readFileSync } from "node:fs";
import { isIP } from "node:net";

type Environment = Readonly<Record<string, string | undefined>>;
type TlsOptions = Readonly<{ rejectUnauthorized: true; ca?: string } | { rejectUnauthorized: false }>;

function isLoopbackOrigin(raw: string | undefined): boolean {
  if (!raw) return false;
  try {
    const hostname = new URL(raw).hostname.replace(/^\[|\]$/gu, "");
    return hostname === "localhost" || hostname === "::1" || (isIP(hostname) === 4 && hostname.startsWith("127."));
  } catch {
    return false;
  }
}

export function securityTlsOptions(
  environment: Environment,
  read: (path: string, encoding: "utf8") => string = readFileSync,
): TlsOptions {
  const insecure = environment.SECURITY_TLS_INSECURE;
  if (insecure !== undefined && insecure !== "true" && insecure !== "false") {
    throw new Error("SECURITY_TLS_INSECURE must be exactly true or false");
  }
  const caPath = environment.SECURITY_TLS_CA_FILE?.trim();
  if (caPath) {
    if (!caPath.startsWith("/")) throw new Error("SECURITY_TLS_CA_FILE must be an absolute path");
    const ca = read(caPath, "utf8");
    if (Buffer.byteLength(ca, "utf8") > 1_048_576 || !/-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----/u.test(ca)) {
      throw new Error("SECURITY_TLS_CA_FILE must contain a PEM CA file no larger than 1 MiB");
    }
    return Object.freeze({ ca, rejectUnauthorized: true });
  }
  if (insecure === "true") {
    if (!isLoopbackOrigin(environment.SECURITY_HTTPS_ORIGIN)) {
      throw new Error("SECURITY_TLS_INSECURE=true is allowed only for an explicit loopback HTTPS origin");
    }
    return Object.freeze({ rejectUnauthorized: false });
  }
  return Object.freeze({ rejectUnauthorized: true });
}
