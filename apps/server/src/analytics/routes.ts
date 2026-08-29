import type { FastifyInstance } from "fastify";
import type { AdminAuthService } from "../auth/admin-auth";
import { authenticateAdminRead } from "../auth/admin-auth";
import { analyticsFiltersSchema } from "./usage";
import type { AnalyticsService } from "./service";

/** Teacher-only endpoint. Aggregate responses intentionally contain no identity/device rows. */
export function registerAnalyticsRoutes(app: FastifyInstance, auth: AdminAuthService, analytics: AnalyticsService): void {
  app.get("/api/admin/analytics", async (request, reply) => {
    const current = await authenticateAdminRead(request, reply, auth); if (!current) return;
    const parsed = analyticsFiltersSchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_ANALYTICS_FILTERS" });
    reply.header("Cache-Control", "private, no-store");
    try { return await analytics.query(parsed.data); }
    catch (error) { auth.report("admin.analytics", error, request.id); return reply.code(503).send({ error: "ANALYTICS_UNAVAILABLE" }); }
  });
}
