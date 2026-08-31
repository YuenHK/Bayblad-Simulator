import type { FastifyInstance, FastifyReply } from "fastify";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";

const contentTypes: Readonly<Record<string, string>> = Object.freeze({
  ".css": "text/css; charset=utf-8", ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon", ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".png": "image/png",
  ".svg": "image/svg+xml", ".webp": "image/webp", ".woff2": "font/woff2",
});

export function registerAdminStaticRoutes(app: FastifyInstance, configuredRoot: string): void {
  const root = resolve(configuredRoot);
  const send = async (relative: string, reply: FastifyReply) => {
    const candidate = resolve(root, relative);
    if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) return reply.code(404).send({ error: "NOT_FOUND" });
    try {
      const body = await readFile(candidate);
      const extension = extname(candidate).toLowerCase();
      reply.header("Content-Type", contentTypes[extension] ?? "application/octet-stream");
      reply.header("Cache-Control", relative === "index.html" ? "no-store" : "public, max-age=31536000, immutable");
      return reply.send(body);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return reply.code(404).send({ error: "NOT_FOUND" });
      throw error;
    }
  };
  app.get("/admin", async (_request, reply) => reply.redirect("/admin/", 308));
  app.get("/admin/*", async (request, reply) => {
    const relative = String((request.params as { "*"?: unknown })["*"] ?? "");
    if (!relative) return send("index.html", reply);
    if (!/^[A-Za-z0-9._/-]+$/u.test(relative) || relative.split("/").includes("..")) return reply.code(404).send({ error: "NOT_FOUND" });
    return send(relative, reply);
  });
}
