import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { createSafeFastifyLoggerOptions, registerSafeRequestLogging, safeLogErrorDetails } from "./safe-logging";

describe("production-safe HTTP logging", () => {
  it("logs only method and validated pathname without URL, query, headers, cookies or body", async () => {
    const chunks: string[] = [];
    const app = Fastify(createSafeFastifyLoggerOptions({ write: (chunk: string) => { chunks.push(chunk); return true; } }));
    registerSafeRequestLogging(app);
    app.get("/start", async () => ({ ok: true }));
    app.get("/api/admin/records", async () => ({ ok: true }));
    app.get("/socket.io/", async () => ({ ok: true }));
    await app.inject({ method: "GET", url: "/start?t=WEBCLIP_SECRET", headers: { cookie: "identity=COOKIE_SECRET" } });
    await app.inject({ method: "GET", url: "/api/admin/records?className=PRIVATE_CLASS&student=PRIVATE_STUDENT" });
    await app.inject({ method: "GET", url: "/socket.io/?EIO=4&transport=polling&sid=SOCKET_SECRET" });
    await app.close();
    const rendered = chunks.join("");
    expect(rendered).toContain('"method":"GET"');
    expect(rendered).toContain('"pathname":"/start"');
    expect(rendered).toContain('"pathname":"/api/admin/records"');
    expect(rendered).toContain('"pathname":"/socket.io/"');
    for (const secret of ["WEBCLIP_SECRET", "COOKIE_SECRET", "PRIVATE_CLASS", "PRIVATE_STUDENT", "SOCKET_SECRET", "className", "student", "sid", "headers", "cookie", "body", "req.url"]) {
      expect(rendered).not.toContain(secret);
    }
  });

  it("replaces invalid or control-character paths and sanitizes manual errors", async () => {
    const chunks: string[] = [];
    const app = Fastify(createSafeFastifyLoggerOptions({ write: (chunk: string) => { chunks.push(chunk); return true; } }));
    registerSafeRequestLogging(app);
    app.get("/boom", async () => { throw Object.assign(new Error("PRIVATE_FAILURE"), { code: "BAD\nSECRET" }); });
    await app.inject({ method: "GET", url: "/boom" });
    app.log.error({ err: Object.assign(new Error("PRIVATE_FAILURE"), { code: "BAD\nSECRET" }) }, "Caught failure");
    app.log.error({ event: "manual.failure", errorName: "RangeError", errorCode: "SAFE_CODE" }, "Operation failed");
    await app.close();
    const rendered = chunks.join("");
    expect(rendered).not.toContain("PRIVATE_FAILURE");
    expect(rendered).not.toContain("BAD\\nSECRET");
    expect(rendered).toContain('"errorName":"Error"');
    expect(rendered).toContain('"errorCode":"BAD_SECRET"');
    expect(rendered).toContain('"errorCode":"SAFE_CODE"');
    expect(safeLogErrorDetails(Object.assign(new Error("PRIVATE"), { name: "Bad\nName", code: "BAD\u0000CODE" }))).toEqual({ errorName: "Bad_Name", errorCode: "BAD_CODE" });
  });
});
