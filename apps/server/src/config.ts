import { readFileSync } from "node:fs";
import { z } from "zod";

const secretNames = [
  "DATABASE_URL",
  "COOKIE_SIGNING_KEY",
  "ADMIN_INITIAL_PASSWORD",
  "ADMIN_CSRF_SECRET",
  "WEBCLIP_SIGNING_KEY",
  "WEBCLIP_EXCHANGE_KEY",
  "ANALYTICS_CURSOR_SECRET",
  "STUDENT_CREDENTIAL_KEY",
] as const;
type SecretName = (typeof secretNames)[number];

const environmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PUBLIC_ORIGIN: z.url(),
  STUDENT_ORIGIN: z.url(),
  ADMIN_USERNAME: z.string().trim().min(1).max(64).default("admin"),
  ADMIN_CSRF_KEY_ID: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/u),
  ICLASS_MODE: z.enum(["api", "csv", "api-csv-fallback", "guest-only-explicit"]),
  ICLASS_API_URL: z.string().optional(),
  ICLASS_DEVICE_MAP_CSV_PATH: z.string().optional(),
  DELETION_LEDGER_FILE: z.string().startsWith("/").min(2),
  DELETION_SOURCE_INSTANCE_ID: z.string().optional(),
  HOST: z.union([z.ipv4(), z.ipv6()]).default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3_000),
  DATABASE_TLS: z.enum(["require", "disable"]).default("require"),
}).passthrough();

export type ProductionConfig = Readonly<{
  nodeEnv: "development" | "test" | "production";
  databaseUrl: string;
  databaseTls: boolean;
  publicOrigin: string;
  studentOrigin: string;
  cookieSigningKey: string;
  adminUsername: string;
  adminInitialPassword: string;
  adminCsrfSecret: string;
  adminCsrfKeyId: string;
  webclipSigningKey: string;
  webclipExchangeKey: string;
  analyticsCursorSecret: string;
  studentCredentialKey: string;
  iClassMode: "api" | "csv" | "api-csv-fallback" | "guest-only-explicit";
  iClassApiUrl?: string;
  iClassApiBearerToken?: string;
  iClassDeviceMapCsvPath?: string;
  deletionLedgerFile: string;
  deletionSourceInstanceId: string;
  host: string;
  port: number;
}>;

function secretValue(environment: NodeJS.ProcessEnv, name: string, readSecret: (path: string) => string): string {
  const direct = environment[name]?.trim();
  const file = environment[`${name}_FILE`]?.trim();
  if (direct && file) throw new Error(`${name} and ${name}_FILE are mutually exclusive`);
  const value = direct ?? (file ? readSecret(file).trim() : "");
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function canonicalSecret(value: string, name: string): void {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error(`${name} must be canonical base64url`);
  const decoded = Buffer.from(value, "base64url");
  if (decoded.byteLength < 32 || decoded.toString("base64url") !== value) throw new Error(`${name} must be canonical base64url encoding of at least 32 bytes`);
}

export function loadConfig(
  environment: NodeJS.ProcessEnv,
  readSecret: (path: string) => string = (path) => readFileSync(path, "utf8"),
): ProductionConfig {
  const parsed = environmentSchema.parse(environment);
  const secrets = Object.fromEntries(secretNames.map((name) => [name, secretValue(environment, name, readSecret)])) as Record<SecretName, string>;
  const deletionSourceInstanceId = secretValue(environment, "DELETION_SOURCE_INSTANCE_ID", readSecret);
  z.uuid().parse(deletionSourceInstanceId);
  z.url().refine((value) => value.startsWith("postgresql://") || value.startsWith("postgres://"), "must be a PostgreSQL URL").parse(secrets.DATABASE_URL);
  for (const name of ["COOKIE_SIGNING_KEY", "ADMIN_CSRF_SECRET", "WEBCLIP_SIGNING_KEY", "WEBCLIP_EXCHANGE_KEY", "ANALYTICS_CURSOR_SECRET", "STUDENT_CREDENTIAL_KEY"] as const) {
    canonicalSecret(secrets[name], name);
  }
  z.string().min(8, "ADMIN_INITIAL_PASSWORD must contain at least 8 characters").parse(secrets.ADMIN_INITIAL_PASSWORD);
  const publicOrigin = new URL(parsed.PUBLIC_ORIGIN);
  const studentOrigin = new URL(parsed.STUDENT_ORIGIN);
  if (publicOrigin.pathname !== "/" || publicOrigin.search || publicOrigin.hash || publicOrigin.username || publicOrigin.password) throw new Error("PUBLIC_ORIGIN must contain only scheme and authority");
  if (parsed.NODE_ENV === "production" && publicOrigin.protocol !== "https:") throw new Error("PUBLIC_ORIGIN must use HTTPS in production");
  if (parsed.NODE_ENV === "production" && publicOrigin.port) throw new Error("PUBLIC_ORIGIN must use the default HTTPS port");
  if (studentOrigin.pathname !== "/" || studentOrigin.search || studentOrigin.hash || studentOrigin.username || studentOrigin.password || (parsed.NODE_ENV === "production" && (studentOrigin.protocol !== "https:" || studentOrigin.port))) throw new Error("STUDENT_ORIGIN must be a default-port HTTPS origin without a path");
  if (studentOrigin.origin === publicOrigin.origin) throw new Error("STUDENT_ORIGIN must differ from PUBLIC_ORIGIN");
  if (parsed.NODE_ENV === "production" && parsed.DATABASE_TLS !== "require") throw new Error("DATABASE_TLS must be require in production");
  if (new Set([secrets.COOKIE_SIGNING_KEY, secrets.ADMIN_CSRF_SECRET, secrets.WEBCLIP_SIGNING_KEY, secrets.WEBCLIP_EXCHANGE_KEY, secrets.ANALYTICS_CURSOR_SECRET, secrets.STUDENT_CREDENTIAL_KEY]).size !== 6) throw new Error("Production secrets must be distinct");
  const apiEnabled = parsed.ICLASS_MODE === "api" || parsed.ICLASS_MODE === "api-csv-fallback";
  const csvEnabled = parsed.ICLASS_MODE === "csv" || parsed.ICLASS_MODE === "api-csv-fallback";
  const iClassApiUrl = parsed.ICLASS_API_URL?.trim();
  const iClassApiBearerToken = apiEnabled ? secretValue(environment, "ICLASS_API_BEARER_TOKEN", readSecret) : undefined;
  if (apiEnabled && (!iClassApiUrl || (parsed.NODE_ENV === "production" && new URL(iClassApiUrl).protocol !== "https:"))) throw new Error("ICLASS_API_URL must be HTTPS when API mode is enabled");
  const iClassDeviceMapCsvPath = parsed.ICLASS_DEVICE_MAP_CSV_PATH?.trim();
  if (csvEnabled && (!iClassDeviceMapCsvPath || (parsed.NODE_ENV === "production" && iClassDeviceMapCsvPath !== "/app/config/iclass-device-map.csv"))) throw new Error("ICLASS_DEVICE_MAP_CSV_PATH must use the fixed production mount");
  return Object.freeze({
    nodeEnv: parsed.NODE_ENV,
    databaseUrl: secrets.DATABASE_URL,
    databaseTls: parsed.DATABASE_TLS === "require",
    publicOrigin: publicOrigin.origin,
    studentOrigin: studentOrigin.origin,
    cookieSigningKey: secrets.COOKIE_SIGNING_KEY,
    adminUsername: parsed.ADMIN_USERNAME,
    adminInitialPassword: secrets.ADMIN_INITIAL_PASSWORD,
    adminCsrfSecret: secrets.ADMIN_CSRF_SECRET,
    adminCsrfKeyId: parsed.ADMIN_CSRF_KEY_ID,
    webclipSigningKey: secrets.WEBCLIP_SIGNING_KEY,
    webclipExchangeKey: secrets.WEBCLIP_EXCHANGE_KEY,
    analyticsCursorSecret: secrets.ANALYTICS_CURSOR_SECRET,
    studentCredentialKey: secrets.STUDENT_CREDENTIAL_KEY,
    iClassMode: parsed.ICLASS_MODE,
    ...(iClassApiUrl ? { iClassApiUrl } : {}),
    ...(iClassApiBearerToken ? { iClassApiBearerToken } : {}),
    ...(iClassDeviceMapCsvPath ? { iClassDeviceMapCsvPath } : {}),
    deletionLedgerFile: parsed.DELETION_LEDGER_FILE,
    deletionSourceInstanceId,
    host: parsed.HOST,
    port: parsed.PORT,
  });
}

export function publicConfig(config: ProductionConfig) {
  return Object.freeze({
    nodeEnv: config.nodeEnv,
    publicOrigin: config.publicOrigin,
    studentOrigin: config.studentOrigin,
    host: config.host,
    port: config.port,
    iClassMode: config.iClassMode,
    databaseTls: config.databaseTls,
  });
}
