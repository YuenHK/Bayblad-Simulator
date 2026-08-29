import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  authenticateAdminMutation,
  authenticateAdminRead,
  durableAudit,
  type AdminAuthService,
  type AdminClientResolver,
} from "../auth/admin-auth";
import { ADMIN_COOKIE_NAME } from "../auth/admin-session";
import type { RoomService } from "../rooms/room-service";
import type { PlatformSettingsStore } from "./platform-settings";
import { InMemoryAdminCommandStore, adminCommandPayloadHash, type AdminCommandStore } from "./command-operations";
const password = z.string().min(8).max(1024);
const actionSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("platform.pause"),
      paused: z.boolean(),
      password,
      operationId: z.uuid(),
    })
    .strict(),
  z
    .object({
      action: z.literal("room.close"),
      roomId: z.string().min(1).max(128),
      password,
      operationId: z.uuid(),
    })
    .strict(),
  z
    .object({
      action: z.literal("room.remove"),
      roomId: z.string().min(1).max(128),
      participantId: z.string().min(1).max(128),
      password,
      operationId: z.uuid(),
    })
    .strict(),
]);
export interface AdminRealtimeCommands {
  setPlatformPaused(paused: boolean): void;
  adminCloseRoom(roomId: string): Promise<void>;
  adminRemoveParticipant(roomId: string, participantId: string): Promise<void>;
}
export function registerAdminDashboardRoutes(
  app: FastifyInstance,
  auth: AdminAuthService,
  rooms: RoomService,
  realtime: AdminRealtimeCommands,
  resolver: AdminClientResolver,
  platformSettings?: PlatformSettingsStore,
  commandStore: AdminCommandStore = new InMemoryAdminCommandStore(),
) {
  app.get("/api/admin/rooms", async (request, reply) => {
    if (!(await authenticateAdminRead(request, reply, auth))) return;
    reply.header("Cache-Control", "private, no-store");
    return { paused: rooms.platformPaused, rooms: rooms.adminRooms() };
  });
  app.post("/api/admin/rooms/actions", async (request, reply) => {
    const current = await authenticateAdminMutation(
      request,
      reply,
      auth,
      resolver,
    );
    if (!current) return;
    const parsed = actionSchema.safeParse(request.body);
    if (!parsed.success)
      return reply.code(400).send({ error: "INVALID_ADMIN_ROOM_ACTION" });
    const command = parsed.data,
      raw = request.cookies[ADMIN_COOKIE_NAME],
      purpose = `room-action:${command.operationId}`;
    if (!raw) return reply.code(401).send({ error: "UNAUTHORIZED" });
    let grant: string | null;
    try {
      grant = await auth.reauthenticate(
        raw,
        String(request.headers["x-csrf-token"] ?? ""),
        command.password,
        purpose,
        resolver(request.raw),
      );
    } catch (error) {
      auth.report("admin.room.reauthenticate", error, request.id);
      return reply.code(503).send({ error: "REAUTHENTICATION_UNAVAILABLE" });
    }
    if (!grant || !(await auth.consumeReauthGrant(raw, grant, purpose)))
      return reply.code(403).send({ error: "REAUTHENTICATION_FAILED" });
    const details =
      command.action === "platform.pause"
        ? {
            operationId: command.operationId,
            action: command.action,
            paused: command.paused,
          }
        : command.action === "room.close"
          ? {
              operationId: command.operationId,
              action: command.action,
              roomId: command.roomId,
            }
          : {
              operationId: command.operationId,
              action: command.action,
              roomId: command.roomId,
              participantId: command.participantId,
            };
    const accepted = await commandStore.accept(command.operationId, adminCommandPayloadHash(details));
    if ("conflict" in accepted) return reply.code(409).send({ error: "OPERATION_ID_CONFLICT" });
    if (!accepted.created) return reply.code(accepted.operation.httpStatus).send(accepted.operation.response);
    try {
      await durableAudit(auth.store, {
        adminUserId: current.user.id,
        adminSessionId: current.session.id,
        action: "admin.room.command.accepted",
        outcome: "success",
        details,
      });
    } catch (error) {
      await commandStore.update(command.operationId, "failed", 503, { error: "ADMIN_COMMAND_ACCEPT_AUDIT_FAILED" });
      auth.report("admin.room.command.accept", error, request.id);
      return reply.code(503).send({ error: "ADMIN_COMMAND_ACCEPT_AUDIT_FAILED" });
    }
    try {
      if (command.action === "platform.pause") { await platformSettings?.writePaused(command.paused); realtime.setPlatformPaused(command.paused); }
      else if (command.action === "room.close") await realtime.adminCloseRoom(command.roomId);
      else await realtime.adminRemoveParticipant(command.roomId, command.participantId);
      await commandStore.update(command.operationId, "applied", 202, { status: "applied" });
    } catch (error) {
      await commandStore.update(command.operationId, "failed", 503, { error: "ADMIN_ROOM_COMMAND_FAILED" });
      auth.report("admin.room.command", error, request.id);
      return reply.code(503).send({ error: "ADMIN_ROOM_COMMAND_FAILED" });
    }
    const completionAudit = () => durableAudit(auth.store, { adminUserId: current.user.id, adminSessionId: current.session.id, action: `admin.${command.action}`, outcome: "success", details });
    try {
      await completionAudit();
      await commandStore.update(command.operationId, "completed", 204, {});
      return reply.code(204).send();
    } catch (error) {
      auth.report("admin.room.command.audit_pending", error, request.id);
      await commandStore.update(command.operationId, "audit_pending", 202, { status: "applied", audit: "pending" });
      setTimeout(() => void completionAudit().then(() => commandStore.update(command.operationId, "completed", 204, {})).catch(retryError => auth.report("admin.room.command.audit_retry", retryError)), 100);
      return reply.code(202).send({ status: "applied", audit: "pending" });
    }
  });
}
