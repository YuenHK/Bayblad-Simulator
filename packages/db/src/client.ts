import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres, {
  type Options,
  type PostgresType,
  type Sql,
} from "postgres";

import * as schema from "./schema";

export type DatabaseSsl = Options<Record<string, PostgresType>>["ssl"];

export type DatabaseClientConfig = Readonly<{
  url: string;
  ssl?: DatabaseSsl;
  maxConnections?: number;
  idleTimeoutSeconds?: number;
  connectTimeoutSeconds?: number;
  applicationName?: string;
}>;

type SqlOptions = Partial<Options<Record<string, PostgresType>>>;
export type SqlClientFactory = (url: string, options: SqlOptions) => Sql;

export type DatabaseClient = Readonly<{
  db: PostgresJsDatabase<typeof schema>;
  sql: Sql;
  close: () => Promise<void>;
}>;

const defaultSqlClientFactory: SqlClientFactory = (url, options) =>
  postgres(url, options);

function requirePositiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
}

/** Creates a lazy postgres.js pool. Importing this module never opens a DB. */
export function createDatabaseClient(
  config: DatabaseClientConfig,
  dependencies: Readonly<{ createSqlClient?: SqlClientFactory }> = {},
): DatabaseClient {
  if (config.url.trim().length === 0) {
    throw new TypeError("Database URL must not be blank");
  }
  const options: SqlOptions = {
    ssl: config.ssl ?? false,
    max: requirePositiveInteger(config.maxConnections ?? 10, "maxConnections"),
    idle_timeout: requirePositiveInteger(
      config.idleTimeoutSeconds ?? 20,
      "idleTimeoutSeconds",
    ),
    connect_timeout: requirePositiveInteger(
      config.connectTimeoutSeconds ?? 10,
      "connectTimeoutSeconds",
    ),
    connection: {
      application_name: config.applicationName ?? "steam-top-simulator",
    },
  };
  const sqlClient = (dependencies.createSqlClient ?? defaultSqlClientFactory)(
    config.url,
    options,
  );
  const db = drizzle(sqlClient, { schema });
  let closePromise: Promise<void> | undefined;

  return Object.freeze({
    db,
    sql: sqlClient,
    close: () => {
      closePromise ??= sqlClient.end({ timeout: 5 });
      return closePromise;
    },
  });
}

export { matchWithDetails } from "./queries";
export * from "./authority";
export * from "./schema";
