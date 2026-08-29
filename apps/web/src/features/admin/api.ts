import type { Fetcher } from "./types";
import type { ZodType } from "zod";
export class AdminApiError extends Error { constructor(readonly status: number, message: string) { super(message); } }
export async function requestJson<T>(fetcher: Fetcher, url: string, init?: RequestInit, schema?: ZodType<T>): Promise<T> {
  const response = await fetcher(url, { credentials: "same-origin", cache: "no-store", ...init });
  if (!response.ok) throw new AdminApiError(response.status, ((await response.json().catch(() => null)) as { error?: string } | null)?.error ?? "REQUEST_FAILED");
  if (response.status === 204) return undefined as T;
  const value: unknown = await response.json();
  if (schema) { const parsed = schema.safeParse(value); if (!parsed.success) throw new AdminApiError(502, "INVALID_SERVER_RESPONSE"); return parsed.data; }
  return value as T;
}
export const jsonHeaders = (csrf?: string) => ({ "Content-Type": "application/json", ...(csrf ? { "X-CSRF-Token": csrf } : {}) });
