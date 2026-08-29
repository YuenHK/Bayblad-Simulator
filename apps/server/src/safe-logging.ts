import { LogController, type FastifyInstance } from "fastify";

type LogStream = Readonly<{ write(chunk: string): void }>;

function safeDiagnostic(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const normalized = value.replace(/[\u0000-\u001f\u007f-\u009f]+/gu, "_").slice(0, 80);
  return /^[A-Za-z0-9_.:-]+$/u.test(normalized) ? normalized : fallback;
}

export function safeLogErrorDetails(error: unknown): Readonly<{ errorName: string; errorCode: string }> {
  const candidate = error as { name?: unknown; code?: unknown };
  return Object.freeze({
    errorName: safeDiagnostic(candidate?.name, "Error"),
    errorCode: safeDiagnostic(candidate?.code, "UNCLASSIFIED"),
  });
}

function safeError(error: unknown): Readonly<{ type: string; message: string; stack: string; errorName: string; errorCode: string }> {
  const details = safeLogErrorDetails(error);
  return Object.freeze({
    type: details.errorName,
    message: "Operation failed",
    stack: "",
    ...details,
  });
}

function safeRoutePath(pathname: unknown): string {
  if (typeof pathname !== "string" || pathname.length < 1 || pathname.length > 256) return "/unmatched";
  return /^\/[A-Za-z0-9._~!$&'()*+,;=:@%/*-]*$/u.test(pathname) ? pathname : "/unmatched";
}

export function createSafeFastifyLoggerOptions(stream?: LogStream) {
  return {
    logger: {
      level: "info",
      serializers: {
        req: () => ({}),
        res: (reply: { statusCode?: number }) => ({ ...(typeof reply.statusCode === "number" ? { statusCode: reply.statusCode } : {}) }),
        err: safeError,
      },
      ...(stream ? { stream } : {}),
    },
    logController: new LogController({ disableRequestLogging: true }),
  } as const;
}

export function registerSafeRequestLogging(app: FastifyInstance): void {
  app.addHook("onResponse", (request, reply, done) => {
    app.log.info({
      event: "http.request.completed",
      method: safeDiagnostic(request.method, "UNKNOWN"),
      pathname: safeRoutePath(request.routeOptions.url),
      statusCode: reply.statusCode,
    }, "Request completed");
    done();
  });
}
