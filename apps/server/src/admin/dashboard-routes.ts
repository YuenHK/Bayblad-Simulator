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
    try {
      await durableAudit(auth.store, {
        adminUserId: current.user.id,
        adminSessionId: current.session.id,
        action: "admin.room.command.accepted",
        outcome: "success",
        details,
      });
      if (command.action === "platform.pause")
        realtime.setPlatformPaused(command.paused);
      else if (command.action === "room.close")
        await realtime.adminCloseRoom(command.roomId);
      else
        await realtime.adminRemoveParticipant(
          command.roomId,
          command.participantId,
        );
      await durableAudit(auth.store, {
        adminUserId: current.user.id,
        adminSessionId: current.session.id,
        action: `admin.${command.action}`,
        outcome: "success",
        details,
      });
      return reply.code(204).send();
    } catch (error) {
      auth.report("admin.room.command", error, request.id);
      try {
        await durableAudit(auth.store, {
          adminUserId: current.user.id,
          adminSessionId: current.session.id,
          action: "admin.room.command.completed",
          outcome: "failure",
          details,
        });
      } catch (auditError) {
        auth.report("admin.room.command.audit", auditError, request.id);
      }
      return reply.code(503).send({ error: "ADMIN_ROOM_COMMAND_FAILED" });
    }
  });
}
