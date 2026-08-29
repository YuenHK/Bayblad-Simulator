import { z } from "zod";

const clean = (max: number) => z.string().trim().min(1).max(max).refine((value) => !/[\u0000-\u001f\u007f]/u.test(value), "control characters forbidden");
export const iClassDeviceSchema = z.strictObject({ externalDeviceId: clean(128), deviceName: clean(128), studentName: clean(80), className: clean(30), studentNumber: clean(30) });
export type IClassDevice = z.infer<typeof iClassDeviceSchema>;
export interface IClassAdapter { resolveDevice(externalDeviceId: string): Promise<IClassDevice | null>; }
export const isTransientIClassError = (error: unknown): boolean => error instanceof Error && error.message === "ICLASS_UNAVAILABLE";

/** Falls back for API 404 and transient availability failures only; invalid/auth responses remain fatal. */
export class FallbackIClassAdapter implements IClassAdapter {
  constructor(readonly primary: IClassAdapter, readonly fallback: IClassAdapter) {}
  async resolveDevice(externalDeviceId: string): Promise<IClassDevice | null> {
    try { return await this.primary.resolveDevice(externalDeviceId) ?? await this.fallback.resolveDevice(externalDeviceId); }
    catch (error) { if (!isTransientIClassError(error)) throw error; return this.fallback.resolveDevice(externalDeviceId); }
  }
}

export class ImportedDeviceMapAdapter implements IClassAdapter {
  #snapshot: ReadonlyMap<string, IClassDevice> = new Map();
  readonly #maxBytes: number; readonly #maxRows: number;
  constructor(options: Readonly<{ maxBytes?: number; maxRows?: number }> = {}) { this.#maxBytes = options.maxBytes ?? 2_000_000; this.#maxRows = options.maxRows ?? 10_000; }
  async replaceFromCsv(csv: string): Promise<number> {
    if (Buffer.byteLength(csv, "utf8") > this.#maxBytes) throw new Error("DEVICE_MAP_TOO_LARGE");
    const rows = parseCsv(csv.replace(/^\uFEFF/u, ""));
    const expected = ["externalDeviceId", "deviceName", "studentName", "className", "studentNumber"];
    if (!rows[0] || rows[0].length !== expected.length || rows[0].some((v, i) => v !== expected[i])) throw new Error("INVALID_DEVICE_MAP_HEADERS");
    if (rows.length - 1 > this.#maxRows) throw new Error("DEVICE_MAP_TOO_MANY_ROWS");
    const next = new Map<string, IClassDevice>();
    for (const values of rows.slice(1)) {
      if (values.length === 1 && values[0] === "") continue;
      if (values.length !== expected.length) throw new Error("INVALID_DEVICE_MAP_ROW");
      for (const value of values) if (/^[\t\r\n ]*[=+@-]/u.test(value)) throw new Error("CSV_FORMULA_FORBIDDEN");
      const item = iClassDeviceSchema.parse(Object.fromEntries(expected.map((key, index) => [key, values[index]])));
      if (next.has(item.externalDeviceId)) throw new Error("DUPLICATE_EXTERNAL_DEVICE_ID");
      next.set(item.externalDeviceId, Object.freeze(item));
    }
    this.#snapshot = next; return next.size;
  }
  async resolveDevice(externalDeviceId: string): Promise<IClassDevice | null> { return this.#snapshot.get(clean(128).parse(externalDeviceId)) ?? null; }
}

function parseCsv(value: string): string[][] {
  const rows: string[][] = []; let row: string[] = []; let field = ""; let quoted = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]!;
    if (quoted) { if (char === '"' && value[index + 1] === '"') { field += '"'; index += 1; } else if (char === '"') quoted = false; else field += char; continue; }
    if (char === '"' && field === "") { quoted = true; continue; }
    if (char === ",") { row.push(field); field = ""; continue; }
    if (char === "\n") { row.push(field.replace(/\r$/u, "")); rows.push(row); row = []; field = ""; continue; }
    field += char;
  }
  if (quoted) throw new Error("INVALID_DEVICE_MAP_CSV");
  row.push(field.replace(/\r$/u, "")); rows.push(row); return rows;
}

export class ApiIClassAdapter implements IClassAdapter {
  readonly #baseUrl: URL; readonly #bearerToken: string; readonly #fetch: typeof fetch; readonly #timeoutMs: number; readonly #maxAttempts: number;
  #failures = 0; #openUntil = 0;
  constructor(input: Readonly<{ baseUrl: string; bearerToken: string; fetcher?: typeof fetch; timeoutMs?: number; maxAttempts?: number; production?: boolean }>) {
    this.#baseUrl = new URL(input.baseUrl); if ((input.production ?? process.env.NODE_ENV === "production") && this.#baseUrl.protocol !== "https:") throw new TypeError("ICLASS_HTTPS_REQUIRED");
    this.#bearerToken = z.string().min(1).max(1_024).parse(input.bearerToken); this.#fetch = input.fetcher ?? fetch; this.#timeoutMs = input.timeoutMs ?? 3_000; this.#maxAttempts = input.maxAttempts ?? 2;
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs < 100 || this.#timeoutMs > 30_000) throw new TypeError("ICLASS_TIMEOUT_INVALID");
    if (!Number.isSafeInteger(this.#maxAttempts) || this.#maxAttempts < 1 || this.#maxAttempts > 5) throw new TypeError("ICLASS_ATTEMPTS_INVALID");
  }
  async resolveDevice(externalDeviceId: string): Promise<IClassDevice | null> {
    const id = clean(128).parse(externalDeviceId); if (Date.now() < this.#openUntil) throw new Error("ICLASS_UNAVAILABLE");
    for (let attempt = 1; attempt <= this.#maxAttempts; attempt += 1) {
      try {
        const url = new URL(`devices/${encodeURIComponent(id)}`, this.#baseUrl.toString().replace(/\/?$/u, "/"));
        const response = await this.#fetch(url, { headers: { accept: "application/json", authorization: `Bearer ${this.#bearerToken}` }, signal: AbortSignal.timeout(this.#timeoutMs) });
        if (response.status === 404) { this.#failures = 0; return null; }
        if (response.status === 401) throw new Error("ICLASS_UNAUTHORIZED");
        if (!response.ok) throw new Error("ICLASS_UNAVAILABLE");
        if (!response.headers.get("content-type")?.toLowerCase().startsWith("application/json")) throw new Error("ICLASS_INVALID_RESPONSE");
        const declared = Number(response.headers.get("content-length")); if (Number.isFinite(declared) && declared > 64 * 1_024) throw new Error("ICLASS_INVALID_RESPONSE");
        const reader = response.body?.getReader(); let size = 0; const chunks: Uint8Array[] = [];
        if (reader) {
          while (true) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > 64 * 1_024) { await reader.cancel(); throw new Error("ICLASS_INVALID_RESPONSE"); } chunks.push(part.value); }
        }
        const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        let parsed: unknown; try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { throw new Error("ICLASS_INVALID_RESPONSE"); }
        const validated = iClassDeviceSchema.safeParse(parsed); if (!validated.success) throw new Error("ICLASS_INVALID_RESPONSE");
        this.#failures = 0; return validated.data;
      } catch (error) {
        if (error instanceof Error && ["ICLASS_UNAUTHORIZED", "ICLASS_INVALID_RESPONSE"].includes(error.message)) throw error;
        if (attempt === this.#maxAttempts) { this.#failures += 1; if (this.#failures >= 3) this.#openUntil = Date.now() + 30_000; throw new Error("ICLASS_UNAVAILABLE"); }
        await new Promise((resolve) => setTimeout(resolve, 25 * attempt));
      }
    }
    throw new Error("ICLASS_UNAVAILABLE");
  }
}
