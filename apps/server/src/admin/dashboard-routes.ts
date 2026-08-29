import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  authenticateAdminMutation,
  authenticateAdminRead,
  type AdminAuthService,
  type AdminClientResolver,
} from "../auth/admin-auth";
import { ADMIN_COOKIE_NAME } from "../auth/admin-session";
import type { RoomService } from "../rooms/room-service";
import { InMemoryPlatformSettingsStore,type PlatformSettingsStore } from "./platform-settings";
import { InMemoryAdminCommandStore, adminCommandPayloadHash, type AdminCommandStore } from "./command-operations";
import { AdminCommandExecutor } from "./command-executor";
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
  adminCloseRoom(roomId: string, signal?: AbortSignal): Promise<void>;
  adminRemoveParticipant(roomId: string, participantId: string, context?: Readonly<{ signal: AbortSignal; currentStep?: string; fence: (completedStep?: string) => Promise<void> }>): Promise<void>;
}
export function registerAdminDashboardRoutes(
  app: FastifyInstance,
  auth: AdminAuthService,
  rooms: RoomService,
  realtime: AdminRealtimeCommands,
  resolver: AdminClientResolver,
  platformSettings: PlatformSettingsStore = new InMemoryPlatformSettingsStore(),
  commandStore: AdminCommandStore = new InMemoryAdminCommandStore(),
  executor: AdminCommandExecutor = new AdminCommandExecutor(commandStore,auth,realtime,platformSettings),
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
    const priorOperation = await commandStore.get(command.operationId);
    if (!priorOperation && command.action !== "platform.pause") {
      const room = rooms.adminRooms().find((candidate) => candidate.roomId === command.roomId);
      if (!room) return reply.code(404).send({ error: "ROOM_NOT_FOUND" });
      if (command.action === "room.remove" && !room.players.concat(room.spectators).some((participant) => participant.id === command.participantId))
        return reply.code(404).send({ error: "PARTICIPANT_NOT_FOUND" });
    }
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
    const accepted = await commandStore.accept({operationId:command.operationId,payloadHash:adminCommandPayloadHash(details),action:command.action,target:command.action==="platform.pause"?"platform":command.roomId,payload:details,adminUserId:current.user.id,adminSessionId:current.session.id});
    if ("conflict" in accepted) return reply.code(409).send({ error: "OPERATION_ID_CONFLICT" });
    await executor.pump();
    const outcome=await commandStore.get(command.operationId);
    if(!outcome)return reply.code(202).send({operationId:command.operationId,status:"accepted"});
    return reply.code(outcome.status==="completed"||outcome.status==="terminal_failed"?200:202).send({operationId:outcome.operationId,status:outcome.status,...outcome.result});
  });
  app.get("/api/admin/rooms/actions/:operationId",async(request,reply)=>{if(!(await authenticateAdminRead(request,reply,auth)))return;const id=(request.params as{operationId?:unknown}).operationId;if(typeof id!=="string"||!z.uuid().safeParse(id).success)return reply.code(400).send({error:"INVALID_OPERATION_ID"});await executor.pump();const operation=await commandStore.get(id);if(!operation)return reply.code(404).send({error:"OPERATION_NOT_FOUND"});return reply.code(operation.status==="completed"||operation.status==="terminal_failed"?200:202).send({operationId:id,status:operation.status,...operation.result});});
}
