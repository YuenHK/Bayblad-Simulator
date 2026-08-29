import type { FastifyInstance } from "fastify";
import { adminAnalyticsSummarySchema } from "@steam-top/protocol";
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
    try { return adminAnalyticsSummarySchema.parse(await analytics.query(parsed.data)); }
    catch (error) { auth.report("admin.analytics", error, request.id); return reply.code(503).send({ error: "ANALYTICS_UNAVAILABLE" }); }
  });
  app.get("/api/admin/analytics/parameters", async (request,reply)=>{
    const current=await authenticateAdminRead(request,reply,auth); if(!current)return;
    const raw=request.query as Record<string,unknown>; const {pageSize:rawSize,cursor,...filterValues}=raw;
    const parsed=analyticsFiltersSchema.safeParse(filterValues); const pageSize=rawSize===undefined?50:typeof rawSize==="string"&&/^\d{1,3}$/u.test(rawSize)?Number(rawSize):NaN;
    if(cursor!==undefined&&(typeof cursor!=="string"||cursor.length>1024))return reply.code(400).send({error:"INVALID_ANALYTICS_CURSOR"});
    if(!parsed.success||!Number.isSafeInteger(pageSize)||pageSize<1||pageSize>100)return reply.code(400).send({error:"INVALID_ANALYTICS_FILTERS"});
    try { const page=await analytics.parameterPage(parsed.data,pageSize,typeof cursor==="string"?cursor:undefined); reply.header("Cache-Control","private, no-store"); return page; }
    catch(error){if(error instanceof RangeError)return reply.code(400).send({error:error.message});auth.report("admin.analytics.parameters",error,request.id);return reply.code(503).send({error:"ANALYTICS_UNAVAILABLE"});}
  });
}
