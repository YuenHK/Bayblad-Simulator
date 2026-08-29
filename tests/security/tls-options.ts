import { readFileSync } from "node:fs";

type Environment = Readonly<Record<string, string | undefined>>;
type TlsOptions = Readonly<{ rejectUnauthorized: true; ca?: string }>;

export function securityTlsOptions(
  environment: Environment,
  read: (path: string, encoding: "utf8") => string = readFileSync,
): TlsOptions {
  const insecure = environment.SECURITY_TLS_INSECURE;
  if (insecure !== undefined) throw new Error("SECURITY_TLS_INSECURE is forbidden; install an explicit trusted CA");
  const caPath = environment.SECURITY_TLS_CA_FILE?.trim();
  if (caPath) {
    if (!caPath.startsWith("/")) throw new Error("SECURITY_TLS_CA_FILE must be an absolute path");
    const ca = read(caPath, "utf8");
    if (Buffer.byteLength(ca, "utf8") > 1_048_576 || !/-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----/u.test(ca)) {
      throw new Error("SECURITY_TLS_CA_FILE must contain a PEM CA file no larger than 1 MiB");
    }
    return Object.freeze({ ca, rejectUnauthorized: true });
  }
  return Object.freeze({ rejectUnauthorized: true });
}
