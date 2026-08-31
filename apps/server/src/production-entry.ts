import { createDatabaseClient } from "@steam-top/db";
import type { IncomingMessage } from "node:http";
import { isIP } from "node:net";
import { ZodError } from "zod";
import { createAdminComposition } from "./auth/composition";
import { loadConfig, publicConfig } from "./config";
import { createIClassComposition } from "./identity/composition";
import { PostgresIdentityStore } from "./identity/postgres-store";
import { IdentityResolver } from "./identity/resolver";
import { startProductionServer } from "./production-bootstrap";
import { safeLogErrorDetails } from "./safe-logging";
import { StudentCredentialService } from "./identity/student-credential";

let startupStage: "config" | "database" | "iclass" | "admin" | "server" = "config";

function configIssuePaths(error: unknown): readonly string[] {
  if (!(error instanceof ZodError)) return [];
  return error.issues.slice(0, 8).map((issue) => `${issue.path.join(".") || "$"}:${issue.code}`);
}

function configErrorCode(error: unknown): string {
  const message = (error as { message?: unknown })?.message;
  if (typeof message !== "string") return "UNCLASSIFIED";
  const variable = message.match(/^([A-Z][A-Z0-9_]*)\s/u)?.[1];
  const allowed = new Set([
    "DATABASE_URL", "COOKIE_SIGNING_KEY", "ADMIN_INITIAL_PASSWORD", "ADMIN_CSRF_SECRET", "WEBCLIP_SIGNING_KEY",
    "WEBCLIP_EXCHANGE_KEY", "ANALYTICS_CURSOR_SECRET", "STUDENT_CREDENTIAL_KEY", "DELETION_SOURCE_INSTANCE_ID",
    "PUBLIC_ORIGIN", "STUDENT_ORIGIN", "ICLASS_API_URL", "ICLASS_DEVICE_MAP_CSV_PATH",
  ]);
  if (variable && allowed.has(variable)) {
    if (message.includes("is required")) return `${variable}_REQUIRED`;
    if (message.includes("mutually exclusive")) return `${variable}_SOURCE_AMBIGUOUS`;
    if (message.includes("canonical base64url")) return `${variable}_NOT_CANONICAL`;
    if (message.includes("must contain")) return `${variable}_TOO_SHORT`;
    if (message.includes("must use") || message.includes("must differ") || message.includes("must contain only")) return `${variable}_INVALID`;
  }
  if (message === "Production secrets must be distinct") return "PRODUCTION_SECRETS_NOT_DISTINCT";
  return "UNCLASSIFIED";
}

function forwardedAddress(request: IncomingMessage): string {
  const raw = request.headers["x-forwarded-for"];
  const first = (Array.isArray(raw) ? raw[0] : raw)?.split(",", 1)[0]?.trim();
  if (!first || isIP(first) === 0) throw new Error("INVALID_TRUSTED_PROXY_ADDRESS");
  return first;
}

async function main(): Promise<void> {
  startupStage = "config";
  const config = loadConfig(process.env);
  process.env.NODE_ENV = config.nodeEnv;
  process.env.PUBLIC_ORIGIN = config.publicOrigin;
  process.env.ADMIN_USERNAME = config.adminUsername;
  process.env.ADMIN_INITIAL_PASSWORD = config.adminInitialPassword;
  process.env.ADMIN_CSRF_SECRET = config.adminCsrfSecret;
  process.env.ADMIN_CSRF_KEY_ID = config.adminCsrfKeyId;
  process.env.WEBCLIP_SIGNING_KEYS_JSON = JSON.stringify({ primary: config.webclipSigningKey });
  process.env.WEBCLIP_ACTIVE_KEY_ID = "primary";
  process.env.WEBCLIP_EXCHANGE_KEY = config.webclipExchangeKey;
  process.env.WEBCLIP_AUDIENCE ??= "steam-top";
  process.env.ANALYTICS_CURSOR_SECRET = config.analyticsCursorSecret;
  process.env.ICLASS_MODE = config.iClassMode;
  if (config.iClassApiBearerToken) process.env.ICLASS_API_BEARER_TOKEN = config.iClassApiBearerToken;
  if (config.iClassApiUrl) process.env.ICLASS_API_URL = config.iClassApiUrl;
  if (config.iClassDeviceMapCsvPath) process.env.ICLASS_DEVICE_MAP_CSV_PATH = config.iClassDeviceMapCsvPath;
  process.env.DELETION_LEDGER_FILE = config.deletionLedgerFile;
  process.env.DELETION_SOURCE_INSTANCE_ID = config.deletionSourceInstanceId;

  startupStage = "database";
  const client = createDatabaseClient({
    url: config.databaseUrl,
    ssl: config.databaseTls ? "require" : false,
    allowInsecure: !config.databaseTls,
    applicationName: "steam-top-server",
  }, { runtimeEnvironment: config.nodeEnv });
  let app: Awaited<ReturnType<typeof startProductionServer>> | undefined;
  try {
    startupStage = "iclass";
    const iClass = await createIClassComposition(process.env, client.db);
    startupStage = "admin";
    const adminAuth = await createAdminComposition(process.env, client.db, [config.publicOrigin]);
    const address = (request: IncomingMessage) => forwardedAddress(request);
    startupStage = "server";
    app = await startProductionServer(client, {
      cookieSigningKey: config.cookieSigningKey,
      allowedOrigins: [config.publicOrigin, config.studentOrigin],
      studentOrigin: config.studentOrigin,
      studentCredentials: new StudentCredentialService({ keys: { primary: Buffer.from(config.studentCredentialKey, "base64url") }, activeKeyId: "primary", origin: config.studentOrigin }),
      behindProxy: true,
      clientKeyResolver: address,
      identityIpResolver: address,
      adminClientKeyResolver: address,
      adminClientAddressResolver: address,
      identityResolver: new IdentityResolver(new PostgresIdentityStore(client.db)),
      adminAuth,
      ...iClass,
    }, { host: config.host, port: config.port });
    app.log.info({ event: "server.started", config: publicConfig(config) }, "Production server started");
    const shutdown = async (signal: string) => {
      app?.log.info({ event: "server.stopping", signal }, "Production server stopping");
      await app?.close();
      await client.close();
    };
    process.once("SIGTERM", () => { void shutdown("SIGTERM"); });
    process.once("SIGINT", () => { void shutdown("SIGINT"); });
  } catch (error) {
    await app?.close().catch(() => undefined);
    await client.close().catch(() => undefined);
    throw error;
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`${JSON.stringify({ level: "fatal", event: "server.start_failed", startupStage, ...safeLogErrorDetails(error), configIssues: configIssuePaths(error), configErrorCode: configErrorCode(error) })}\n`);
  process.exitCode = 1;
});
