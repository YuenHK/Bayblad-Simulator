import type { DatabaseClient } from "@steam-top/db";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { ApiIClassAdapter, FallbackIClassAdapter, ImportedDeviceMapAdapter, type IClassAdapter } from "./iclass-adapter";
import { PostgresTokenNonceStore } from "./postgres-token-nonce";
import { WebClipTokenService } from "./webclip-token";

const modeSchema = z.enum(["api", "csv", "api-csv-fallback", "guest-only-explicit"]);
export type IClassMode = z.infer<typeof modeSchema>;
export type IClassComposition = Readonly<{ iClassStatus: "api" | "csv" | "api-csv-fallback" | "disabled"; iClassAdapter?: IClassAdapter; webClipTokens?: WebClipTokenService }>;
const required = (env: NodeJS.ProcessEnv, name: string): string => { const value = env[name]?.trim(); if (!value) throw new Error(`MISSING_${name}`); return value; };

function signingKeys(env: NodeJS.ProcessEnv): Readonly<Record<string, Uint8Array>> {
  let raw: unknown; try { raw = JSON.parse(required(env, "WEBCLIP_SIGNING_KEYS_JSON")); } catch (error) { if (error instanceof SyntaxError) throw new Error("INVALID_WEBCLIP_SIGNING_KEYS_JSON"); throw error; }
  const values = z.record(z.string().min(1).max(32), z.string().min(43).max(256)).parse(raw);
  return Object.fromEntries(Object.entries(values).map(([kid, encoded]) => {
    const bytes = Buffer.from(encoded, "base64url"); if (bytes.byteLength < 32 || bytes.toString("base64url") !== encoded) throw new Error("INVALID_WEBCLIP_SIGNING_KEY"); return [kid, Uint8Array.from(bytes)];
  }));
}
function exchangeKey(env: NodeJS.ProcessEnv): Uint8Array {
  const encoded = required(env, "WEBCLIP_EXCHANGE_KEY"); const bytes = Buffer.from(encoded, "base64url");
  if (bytes.byteLength < 32 || bytes.toString("base64url") !== encoded) throw new Error("INVALID_WEBCLIP_EXCHANGE_KEY"); return Uint8Array.from(bytes);
}

export async function createIClassComposition(env: NodeJS.ProcessEnv, db: DatabaseClient["db"], dependencies: Readonly<{ fetcher?: typeof fetch; readCsv?: (path: string) => Promise<string> }> = {}): Promise<IClassComposition> {
  const mode = modeSchema.parse(required(env, "ICLASS_MODE"));
  if (mode === "guest-only-explicit") return Object.freeze({ iClassStatus: "disabled" });
  const keys = signingKeys(env); const activeKeyId = required(env, "WEBCLIP_ACTIVE_KEY_ID");
  const tokens = new WebClipTokenService({ keys, activeKeyId, audience: required(env, "WEBCLIP_AUDIENCE"), nonceStore: new PostgresTokenNonceStore(db), exchangeKey: exchangeKey(env), production: true });
  const makeCsv = async () => {
    const adapter = new ImportedDeviceMapAdapter(); const path = required(env, "ICLASS_DEVICE_MAP_CSV_PATH");
    const text = dependencies.readCsv ? await dependencies.readCsv(path) : await readFile(path, "utf8"); await adapter.replaceFromCsv(text); return adapter;
  };
  const makeApi = () => new ApiIClassAdapter({ baseUrl: required(env, "ICLASS_API_URL"), bearerToken: required(env, "ICLASS_API_BEARER_TOKEN"), timeoutMs: Number(env.ICLASS_API_TIMEOUT_MS ?? "3000"), maxAttempts: Number(env.ICLASS_API_MAX_ATTEMPTS ?? "2"), ...(dependencies.fetcher ? { fetcher: dependencies.fetcher } : {}), production: true });
  if (mode === "api") return Object.freeze({ iClassStatus: "api", iClassAdapter: makeApi(), webClipTokens: tokens });
  if (mode === "csv") return Object.freeze({ iClassStatus: "csv", iClassAdapter: await makeCsv(), webClipTokens: tokens });
  return Object.freeze({ iClassStatus: "api-csv-fallback", iClassAdapter: new FallbackIClassAdapter(makeApi(), await makeCsv()), webClipTokens: tokens });
}
