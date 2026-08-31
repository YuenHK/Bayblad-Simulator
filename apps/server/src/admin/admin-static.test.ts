import Fastify from "fastify";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import { registerAdminStaticRoutes } from "./admin-static";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

it("serves the admin SPA and immutable assets from the same origin", async () => {
  const root = await mkdtemp(join(tmpdir(), "admin-static-")); roots.push(root);
  await mkdir(join(root, "assets"));
  await writeFile(join(root, "index.html"), "<!doctype html><div id=app></div>");
  await writeFile(join(root, "assets", "app.js"), "console.log('admin')");
  const app = Fastify(); registerAdminStaticRoutes(app, root); await app.ready();
  expect((await app.inject({ url: "/admin" })).headers.location).toBe("/admin/");
  expect((await app.inject({ url: "/admin/" })).body).toContain("id=app");
  const asset = await app.inject({ url: "/admin/assets/app.js" });
  expect(asset.statusCode).toBe(200); expect(asset.headers["content-type"]).toContain("javascript");
  expect(asset.headers["cache-control"]).toContain("immutable");
  expect((await app.inject({ url: "/admin/../secret" })).statusCode).toBe(404);
  await app.close();
});
