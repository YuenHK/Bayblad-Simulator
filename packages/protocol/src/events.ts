import { z } from "zod";

const boundedIdSchema = z.string().trim().min(1).max(128);
const roomCodeSchema = z.string().trim().min(1).max(32);
const roomNameSchema = z.string().trim().min(1).max(30);
const displayNameSchema = z.string().trim().min(1).max(80);
const eventIdSchema = z.uuid();
const finiteNumberSchema = z.number().finite();
const nonnegativeFiniteNumberSchema = finiteNumberSchema.nonnegative();

export const phaseSchema = z.enum(["waiting", "launch", "battle", "result"]);
export type Phase = z.infer<typeof phaseSchema>;

export const launchGradeSchema = z.enum(["Perfect", "Great", "Good", "Miss"]);
export type LaunchGrade = z.infer<typeof launchGradeSchema>;

export const roomCreateEventSchema = z
  .object({
    type: z.literal("room.create"),
    name: roomNameSchema,
    eventId: eventIdSchema,
  })
  .strict();

export const roomJoinEventSchema = z
  .object({
    type: z.literal("room.join"),
    roomId: boundedIdSchema,
    role: z.enum(["player", "spectator"]),
    eventId: eventIdSchema,
  })
  .strict();

export const roomMoveEventSchema = z
  .object({
    type: z.literal("room.move"),
    roomId: boundedIdSchema,
    target: z.enum(["player1", "player2", "spectator"]),
    eventId: eventIdSchema,
  })
  .strict();

export const playerReadyEventSchema = z
  .object({
    type: z.literal("player.ready"),
    roomId: boundedIdSchema,
    designId: z.uuid(),
    eventId: eventIdSchema,
  })
  .strict();

export const launchTapEventSchema = z
  .object({
    type: z.literal("launch.tap"),
    roomId: boundedIdSchema,
    roundId: boundedIdSchema,
    nonce: boundedIdSchema,
    clientTimeMs: finiteNumberSchema,
    eventId: eventIdSchema,
  })
  .strict();

export const roomCloseEventSchema = z
  .object({
    type: z.literal("room.close"),
    roomId: boundedIdSchema,
    eventId: eventIdSchema,
  })
  .strict();

export const clientEventSchema = z.discriminatedUnion("type", [
  roomCreateEventSchema,
  roomJoinEventSchema,
  roomMoveEventSchema,
  playerReadyEventSchema,
  launchTapEventSchema,
  roomCloseEventSchema,
]);
export type ClientEvent = z.infer<typeof clientEventSchema>;

export type RoomCreateEvent = z.infer<typeof roomCreateEventSchema>;
export type RoomJoinEvent = z.infer<typeof roomJoinEventSchema>;
export type RoomMoveEvent = z.infer<typeof roomMoveEventSchema>;
export type PlayerReadyEvent = z.infer<typeof playerReadyEventSchema>;
export type LaunchTapEvent = z.infer<typeof launchTapEventSchema>;
export type RoomCloseEvent = z.infer<typeof roomCloseEventSchema>;

export const lobbySeatSchema = z
  .object({ displayName: displayNameSchema.nullable() })
  .strict();
export type LobbySeat = z.infer<typeof lobbySeatSchema>;

export const lobbyRoomSchema = z
  .object({
    id: boundedIdSchema,
    code: roomCodeSchema,
    name: roomNameSchema,
    phase: phaseSchema,
    player1: lobbySeatSchema,
    player2: lobbySeatSchema,
    spectatorCount: z.number().int().nonnegative(),
  })
  .strict();
export type LobbyRoom = z.infer<typeof lobbyRoomSchema>;

export const lobbySnapshotEventSchema = z
  .object({
    type: z.literal("lobby.snapshot"),
    rooms: z.array(lobbyRoomSchema),
  })
  .strict();

export const roomSeatSchema = z
  .object({
    userId: boundedIdSchema.nullable(),
    displayName: displayNameSchema.nullable(),
    ready: z.boolean().nullable(),
    designId: z.uuid().nullable(),
  })
  .strict();
export type RoomSeat = z.infer<typeof roomSeatSchema>;

export const spectatorSchema = z
  .object({
    userId: boundedIdSchema,
    displayName: displayNameSchema,
  })
  .strict();
export type Spectator = z.infer<typeof spectatorSchema>;

export const viewerRoleSchema = z.enum(["player1", "player2", "spectator"]);
export type ViewerRole = z.infer<typeof viewerRoleSchema>;

export const roomSnapshotEventSchema = z
  .object({
    type: z.literal("room.snapshot"),
    id: boundedIdSchema,
    code: roomCodeSchema,
    name: roomNameSchema,
    ownerId: boundedIdSchema,
    phase: phaseSchema,
    player1: roomSeatSchema,
    player2: roomSeatSchema,
    spectators: z.array(spectatorSchema),
    viewerRole: viewerRoleSchema,
    viewerUserId: boundedIdSchema,
  })
  .strict();

export const launchScheduleEventSchema = z
  .object({
    type: z.literal("launch.schedule"),
    roomId: boundedIdSchema,
    roundId: boundedIdSchema,
    serverTargetTimeMs: nonnegativeFiniteNumberSchema,
    nonce: boundedIdSchema,
  })
  .strict();

export const launchResultSchema = z
  .object({
    userId: boundedIdSchema,
    grade: launchGradeSchema,
    angularMultiplier: nonnegativeFiniteNumberSchema,
    impulseMultiplier: nonnegativeFiniteNumberSchema,
  })
  .strict();
export type LaunchResult = z.infer<typeof launchResultSchema>;

export const launchResultPrivateEventSchema = z
  .object({
    type: z.literal("launch.result.private"),
    userId: boundedIdSchema,
    grade: launchGradeSchema,
    angularMultiplier: nonnegativeFiniteNumberSchema,
    impulseMultiplier: nonnegativeFiniteNumberSchema,
  })
  .strict();

export const launchResultSpectatorEventSchema = z
  .object({
    type: z.literal("launch.result.spectator"),
    A: launchResultSchema.extend({ displayName: displayNameSchema }).strict(),
    B: launchResultSchema.extend({ displayName: displayNameSchema }).strict(),
  })
  .strict();

export const battleBodySchema = z
  .object({
    x: finiteNumberSchema,
    y: finiteNumberSchema,
    angle: finiteNumberSchema,
    angularSpeed: finiteNumberSchema,
  })
  .strict();
export type BattleBody = z.infer<typeof battleBodySchema>;

export const battleFrameEventSchema = z
  .object({
    type: z.literal("battle.frame"),
    roomId: boundedIdSchema,
    matchId: boundedIdSchema,
    tick: z.number().int().nonnegative(),
    a: battleBodySchema,
    b: battleBodySchema,
  })
  .strict();

export const roundWinnerSchema = z.enum(["A", "B", "draw"]);
export type RoundWinner = z.infer<typeof roundWinnerSchema>;

export const roundFinishedEventSchema = z
  .object({
    type: z.literal("round.finished"),
    winner: roundWinnerSchema,
  })
  .strict();

export const matchScoreSchema = z
  .object({
    battlePoints: nonnegativeFiniteNumberSchema,
    challengePoints: nonnegativeFiniteNumberSchema,
    total: nonnegativeFiniteNumberSchema,
  })
  .strict();
export type MatchScore = z.infer<typeof matchScoreSchema>;

export const matchFinishedEventSchema = z
  .object({
    type: z.literal("match.finished"),
    A: matchScoreSchema,
    B: matchScoreSchema,
    roundWinners: z.array(roundWinnerSchema),
  })
  .strict();

export const errorEventSchema = z
  .object({
    type: z.literal("error"),
    code: z.string().trim().min(1).max(64),
    message: z.string().trim().min(1).max(500),
    eventId: eventIdSchema.optional(),
  })
  .strict();

export const serverEventSchema = z.discriminatedUnion("type", [
  lobbySnapshotEventSchema,
  roomSnapshotEventSchema,
  launchScheduleEventSchema,
  launchResultPrivateEventSchema,
  launchResultSpectatorEventSchema,
  battleFrameEventSchema,
  roundFinishedEventSchema,
  matchFinishedEventSchema,
  errorEventSchema,
]);
export type ServerEvent = z.infer<typeof serverEventSchema>;

export type LobbySnapshotEvent = z.infer<typeof lobbySnapshotEventSchema>;
export type RoomSnapshotEvent = z.infer<typeof roomSnapshotEventSchema>;
export type LaunchScheduleEvent = z.infer<typeof launchScheduleEventSchema>;
export type LaunchResultPrivateEvent = z.infer<typeof launchResultPrivateEventSchema>;
export type LaunchResultSpectatorEvent = z.infer<typeof launchResultSpectatorEventSchema>;
export type BattleFrameEvent = z.infer<typeof battleFrameEventSchema>;
export type RoundFinishedEvent = z.infer<typeof roundFinishedEventSchema>;
export type MatchFinishedEvent = z.infer<typeof matchFinishedEventSchema>;
export type ErrorEvent = z.infer<typeof errorEventSchema>;
