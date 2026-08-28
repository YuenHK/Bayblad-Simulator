import { z } from "zod";

export const PROTOCOL_VERSION = 1 as const;

export const protocolVersionSchema = z.literal(PROTOCOL_VERSION);
export type ProtocolVersion = z.infer<typeof protocolVersionSchema>;

export const correlationIdSchema = z.string().trim().min(1).max(128);
export type CorrelationId = z.infer<typeof correlationIdSchema>;

export const participantIdSchema = z.string().trim().min(1).max(32);
export type ParticipantId = z.infer<typeof participantIdSchema>;

const roomCodeSchema = z.string().trim().min(1).max(32);
const unsafePublicNameCharacterPattern = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;
const publicNameSchema = (maximumLength: number) =>
  z
    .string()
    .transform((value) => value.trim().normalize("NFC"))
    .pipe(
      z
        .string()
        .min(1)
        .max(maximumLength)
        .refine((value) => !unsafePublicNameCharacterPattern.test(value), {
          message: "Public names must not contain control or bidirectional formatting characters",
        }),
    );
const roomNameSchema = publicNameSchema(30);
const displayNameSchema = publicNameSchema(80);
export const eventIdSchema = z.uuid();
export type EventId = z.infer<typeof eventIdSchema>;

const finiteNumberSchema = z.number().finite();
const nonnegativeFiniteNumberSchema = finiteNumberSchema.nonnegative();
const safeNonnegativeIntegerSchema = z
  .number()
  .finite()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);
const commandEnvelopeShape = {
  protocolVersion: protocolVersionSchema,
  eventId: eventIdSchema,
};
const serverEnvelopeShape = {
  protocolVersion: protocolVersionSchema,
  serverEventId: eventIdSchema,
};
const battleCorrelationShape = {
  roomId: correlationIdSchema,
  matchId: correlationIdSchema,
  roundId: correlationIdSchema,
};

export const phaseSchema = z.enum(["waiting", "launch", "battle", "result"]);
export type Phase = z.infer<typeof phaseSchema>;

export const launchGradeSchema = z.enum(["Perfect", "Great", "Good", "Miss"]);
export type LaunchGrade = z.infer<typeof launchGradeSchema>;

export const protocolHelloEventSchema = z
  .object({
    type: z.literal("protocol.hello"),
    eventId: eventIdSchema,
    supportedVersions: z
      .array(z.number().finite().int().min(1).max(255))
      .min(1)
      .max(8)
      .superRefine((versions, context) => {
        if (new Set(versions).size !== versions.length) {
          context.addIssue({
            code: "custom",
            message: "Supported protocol versions must be unique",
          });
        }
      }),
  })
  .strict();

export const roomCreateEventSchema = z
  .object({
    type: z.literal("room.create"),
    name: roomNameSchema,
    ...commandEnvelopeShape,
  })
  .strict();

export const roomJoinEventSchema = z
  .object({
    type: z.literal("room.join"),
    roomId: correlationIdSchema,
    role: z.enum(["player", "spectator"]),
    ...commandEnvelopeShape,
  })
  .strict();

export const roomMoveEventSchema = z
  .object({
    type: z.literal("room.move"),
    roomId: correlationIdSchema,
    target: z.enum(["player1", "player2", "spectator"]),
    subjectParticipantId: participantIdSchema.optional(),
    ...commandEnvelopeShape,
  })
  .strict();

export const playerReadyEventSchema = z
  .object({
    type: z.literal("player.ready"),
    roomId: correlationIdSchema,
    designId: z.uuid(),
    ...commandEnvelopeShape,
  })
  .strict();

export const launchTapEventSchema = z
  .object({
    type: z.literal("launch.tap"),
    roomId: correlationIdSchema,
    roundId: correlationIdSchema,
    nonce: correlationIdSchema,
    clientTimeMs: safeNonnegativeIntegerSchema,
    ...commandEnvelopeShape,
  })
  .strict();

export const roomCloseEventSchema = z
  .object({
    type: z.literal("room.close"),
    roomId: correlationIdSchema,
    ...commandEnvelopeShape,
  })
  .strict();

export const roomLeaveEventSchema = z
  .object({
    type: z.literal("room.leave"),
    roomId: correlationIdSchema,
    ...commandEnvelopeShape,
  })
  .strict();

export const clockSampleSchema = z.object({
  clientSentAtMs: safeNonnegativeIntegerSchema,
  serverReceivedAtMs: safeNonnegativeIntegerSchema,
  serverSentAtMs: safeNonnegativeIntegerSchema,
  clientReceivedAtMs: safeNonnegativeIntegerSchema,
}).strict();

export const clockPingEventSchema = z.object({
  type: z.literal("clock.ping"),
  pingId: correlationIdSchema,
  clientSendTimeMs: safeNonnegativeIntegerSchema,
  previousSample: clockSampleSchema.optional(),
  ...commandEnvelopeShape,
}).strict();

export const v1CommandEventSchema = z.discriminatedUnion("type", [
  roomCreateEventSchema,
  roomJoinEventSchema,
  roomMoveEventSchema,
  playerReadyEventSchema,
  launchTapEventSchema,
  clockPingEventSchema,
  roomLeaveEventSchema,
  roomCloseEventSchema,
]);
export type V1CommandEvent = z.infer<typeof v1CommandEventSchema>;

export const clientEventSchema = z.discriminatedUnion("type", [
  protocolHelloEventSchema,
  roomCreateEventSchema,
  roomJoinEventSchema,
  roomMoveEventSchema,
  playerReadyEventSchema,
  launchTapEventSchema,
  clockPingEventSchema,
  roomLeaveEventSchema,
  roomCloseEventSchema,
]);
export type ClientEvent = z.infer<typeof clientEventSchema>;

export type ProtocolHelloEvent = z.infer<typeof protocolHelloEventSchema>;
export type RoomCreateEvent = z.infer<typeof roomCreateEventSchema>;
export type RoomJoinEvent = z.infer<typeof roomJoinEventSchema>;
export type RoomMoveEvent = z.infer<typeof roomMoveEventSchema>;
export type PlayerReadyEvent = z.infer<typeof playerReadyEventSchema>;
export type LaunchTapEvent = z.infer<typeof launchTapEventSchema>;
export type ClockPingEvent = z.infer<typeof clockPingEventSchema>;
export type RoomLeaveEvent = z.infer<typeof roomLeaveEventSchema>;
export type RoomCloseEvent = z.infer<typeof roomCloseEventSchema>;

export const protocolWelcomeEventSchema = z
  .object({
    type: z.literal("protocol.welcome"),
    selectedVersion: protocolVersionSchema,
    sessionToken: z.string().min(32).max(256).optional(),
    sessionStatus: z.enum(["new", "resumed", "replaced"]).optional(),
    ...serverEnvelopeShape,
  })
  .strict();

const knownProtocolVersionsSchema = z
  .array(protocolVersionSchema)
  .min(1)
  .max(8)
  .superRefine((versions, context) => {
    if (new Set(versions).size !== versions.length) {
      context.addIssue({ code: "custom", message: "Supported versions must be unique" });
    }
  });

export const protocolUnsupportedEventSchema = z
  .object({
    type: z.literal("protocol.unsupported"),
    serverEventId: eventIdSchema,
    supportedVersions: knownProtocolVersionsSchema,
    causedByEventId: eventIdSchema,
    reason: publicNameSchema(160),
  })
  .strict();

export const handshakeServerEventSchema = z.discriminatedUnion("type", [
  protocolWelcomeEventSchema,
  protocolUnsupportedEventSchema,
]);
export type HandshakeServerEvent = z.infer<typeof handshakeServerEventSchema>;

export const lobbySeatSchema = z
  .object({ displayName: displayNameSchema.nullable() })
  .strict();
export type LobbySeat = z.infer<typeof lobbySeatSchema>;

export const lobbyRoomSchema = z
  .object({
    id: correlationIdSchema,
    code: roomCodeSchema,
    name: roomNameSchema,
    phase: phaseSchema,
    player1: lobbySeatSchema,
    player2: lobbySeatSchema,
    spectatorCount: safeNonnegativeIntegerSchema,
  })
  .strict();
export type LobbyRoom = z.infer<typeof lobbyRoomSchema>;

export const lobbySnapshotEventSchema = z
  .object({
    type: z.literal("lobby.snapshot"),
    revision: safeNonnegativeIntegerSchema,
    rooms: z.array(lobbyRoomSchema),
    ...serverEnvelopeShape,
  })
  .strict();

export const occupiedSeatSchema = z
  .object({
    participantId: participantIdSchema,
    displayName: displayNameSchema,
    ready: z.boolean(),
    designId: z.uuid().nullable(),
  })
  .strict()
  .superRefine((seat, context) => {
    if (seat.ready && seat.designId === null) {
      context.addIssue({
        code: "custom",
        message: "A ready player must have a design id",
        path: ["designId"],
      });
    }
  });
export type OccupiedSeat = z.infer<typeof occupiedSeatSchema>;

export const roomSeatSchema = occupiedSeatSchema.nullable();
export type RoomSeat = z.infer<typeof roomSeatSchema>;

export const participantSummarySchema = z
  .object({
    participantId: participantIdSchema,
    displayName: displayNameSchema,
  })
  .strict();
export type ParticipantSummary = z.infer<typeof participantSummarySchema>;

export const spectatorSchema = participantSummarySchema;
export type Spectator = z.infer<typeof spectatorSchema>;

export const viewerRoleSchema = z.enum(["player1", "player2", "spectator"]);
export type ViewerRole = z.infer<typeof viewerRoleSchema>;

export const viewerSchema = z
  .object({
    participantId: participantIdSchema,
    isOwner: z.boolean(),
    role: viewerRoleSchema,
  })
  .strict();
export type Viewer = z.infer<typeof viewerSchema>;

export type ViewerStateSource = {
  readonly ownerParticipantId: ParticipantId;
  readonly player1: RoomSeat;
  readonly player2: RoomSeat;
  readonly spectators: readonly ParticipantSummary[];
};

export const deriveViewerState = (
  roomState: ViewerStateSource,
  participantId: string,
): Viewer => {
  const normalizedParticipantId = participantIdSchema.parse(participantId);
  const locations: ViewerRole[] = [];
  if (roomState.player1?.participantId === normalizedParticipantId) {
    locations.push("player1");
  }
  if (roomState.player2?.participantId === normalizedParticipantId) {
    locations.push("player2");
  }
  for (const spectator of roomState.spectators) {
    if (spectator.participantId === normalizedParticipantId) locations.push("spectator");
  }
  if (locations.length !== 1) {
    throw new Error("Participant must appear in exactly one room location");
  }
  return {
    participantId: normalizedParticipantId,
    role: locations[0]!,
    isOwner: normalizedParticipantId === roomState.ownerParticipantId,
  };
};

export const roomSnapshotEventSchema = z
  .object({
    type: z.literal("room.snapshot"),
    roomId: correlationIdSchema,
    code: roomCodeSchema,
    name: roomNameSchema,
    ownerParticipantId: participantIdSchema,
    phase: phaseSchema,
    revision: safeNonnegativeIntegerSchema,
    player1: roomSeatSchema,
    player2: roomSeatSchema,
    spectators: z.array(spectatorSchema),
    viewer: viewerSchema,
    ...serverEnvelopeShape,
  })
  .strict()
  .superRefine((room, context) => {
    const locations = [
      ...(room.player1 === null
        ? []
        : [{ participantId: room.player1.participantId, role: "player1" as const }]),
      ...(room.player2 === null
        ? []
        : [{ participantId: room.player2.participantId, role: "player2" as const }]),
      ...room.spectators.map((spectator) => ({
        participantId: spectator.participantId,
        role: "spectator" as const,
      })),
    ];
    const participantIds = locations.map((location) => location.participantId);
    if (new Set(participantIds).size !== participantIds.length) {
      context.addIssue({
        code: "custom",
        message: "A participant may occupy only one room location",
        path: ["spectators"],
      });
    }

    try {
      const derivedViewer = deriveViewerState(room, room.viewer.participantId);
      if (
        derivedViewer.role !== room.viewer.role ||
        derivedViewer.isOwner !== room.viewer.isOwner
      ) {
        context.addIssue({
          code: "custom",
          message: "Viewer state must match the participant's room location and ownership",
          path: ["viewer"],
        });
      }
    } catch {
      context.addIssue({
        code: "custom",
        message: "Viewer must appear in exactly one room location",
        path: ["viewer"],
      });
    }
  });

export const roomStatePatchSchema = z
  .object({
    ownerParticipantId: participantIdSchema.optional(),
    phase: phaseSchema.optional(),
    player1: roomSeatSchema.optional(),
    player2: roomSeatSchema.optional(),
    spectatorCount: safeNonnegativeIntegerSchema.optional(),
    name: roomNameSchema.optional(),
  })
  .strict();
export type RoomStatePatch = z.infer<typeof roomStatePatchSchema>;

export const roomDeltaEventSchema = z
  .object({
    type: z.literal("room.delta"),
    roomId: correlationIdSchema,
    baseRevision: safeNonnegativeIntegerSchema,
    revision: safeNonnegativeIntegerSchema,
    patch: roomStatePatchSchema,
    joined: z.array(participantSummarySchema),
    leftParticipantIds: z.array(participantIdSchema),
    ...serverEnvelopeShape,
  })
  .strict()
  .superRefine((delta, context) => {
    if (delta.revision !== delta.baseRevision + 1) {
      context.addIssue({
        code: "custom",
        message: "Room revision must immediately follow its base revision",
        path: ["revision"],
      });
    }

    const joinedIds = delta.joined.map((participant) => participant.participantId);
    const leftIds = delta.leftParticipantIds;
    if (new Set(joinedIds).size !== joinedIds.length) {
      context.addIssue({
        code: "custom",
        message: "Joined participant ids must be unique",
        path: ["joined"],
      });
    }
    if (new Set(leftIds).size !== leftIds.length) {
      context.addIssue({
        code: "custom",
        message: "Left participant ids must be unique",
        path: ["leftParticipantIds"],
      });
    }
    const leftSet = new Set(leftIds);
    if (joinedIds.some((participantId) => leftSet.has(participantId))) {
      context.addIssue({
        code: "custom",
        message: "A participant cannot join and leave in the same delta",
        path: ["leftParticipantIds"],
      });
    }

    const hasStateChange = Object.values(delta.patch).some((value) => value !== undefined);
    if (!hasStateChange && joinedIds.length === 0 && leftIds.length === 0) {
      context.addIssue({ code: "custom", message: "Room delta must contain at least one change" });
    }
  });

export const launchScheduleEventSchema = z
  .object({
    type: z.literal("launch.schedule"),
    ...battleCorrelationShape,
    serverTargetTimeMs: safeNonnegativeIntegerSchema,
    nonce: correlationIdSchema,
    ...serverEnvelopeShape,
  })
  .strict();

const publicBattleLayerSchema = z.object({
  id: correlationIdSchema,
  position: z.enum(["top", "middle", "bottom"]),
  shape: z.enum(["circle", "polygon", "star", "wave"]),
  points: z.number().int().min(3).max(16),
  diameterMm: z.number().finite().min(20).max(80),
  cornerRoundness: z.number().finite().min(0).max(1),
  rotationDeg: z.number().finite().min(0).max(359),
  color: z.string().regex(/^#[0-9a-f]{6}$/i),
}).strict();

export const publicBattleDesignSchema = z.object({
  layers: z.tuple([
    publicBattleLayerSchema.extend({ position: z.literal("top") }),
    publicBattleLayerSchema.extend({ position: z.literal("middle") }),
    publicBattleLayerSchema.extend({ position: z.literal("bottom") }),
  ]),
  screwLayout: z.object({
    count: z.number().int().min(3).max(8),
    radiusMm: z.number().finite().min(5).max(25),
    rotationDeg: z.number().finite().min(0).max(359),
  }).strict(),
  metalDiscDiameterMm: z.union([z.literal(0), z.number().finite().min(10).max(55)]),
}).strict();
export type PublicBattleDesign = z.infer<typeof publicBattleDesignSchema>;

const battleStartedPlayerSchema = z.object({
  participantId: participantIdSchema,
  designId: z.uuid(),
  design: publicBattleDesignSchema,
}).strict();

export const battleStartedEventSchema = z.object({
  type: z.literal("battle.started"),
  roomId: correlationIdSchema,
  matchId: correlationIdSchema,
  player1: battleStartedPlayerSchema,
  player2: battleStartedPlayerSchema,
  ...serverEnvelopeShape,
}).strict();
export type BattleStartedEvent = z.infer<typeof battleStartedEventSchema>;

export const LAUNCH_MULTIPLIER_MIN = 0;
export const LAUNCH_MULTIPLIER_MAX = 2;
const launchMultiplierSchema = z
  .number()
  .finite()
  .min(LAUNCH_MULTIPLIER_MIN)
  .max(LAUNCH_MULTIPLIER_MAX);

export const launchResultSchema = z
  .object({
    participantId: participantIdSchema,
    displayName: displayNameSchema,
    grade: launchGradeSchema,
    angularMultiplier: launchMultiplierSchema,
    impulseMultiplier: launchMultiplierSchema,
  })
  .strict();
export type LaunchResult = z.infer<typeof launchResultSchema>;

export const launchResultPrivateEventSchema = z
  .object({
    type: z.literal("launch.result.private"),
    ...battleCorrelationShape,
    participantId: participantIdSchema,
    grade: launchGradeSchema,
    angularMultiplier: launchMultiplierSchema,
    impulseMultiplier: launchMultiplierSchema,
    ...serverEnvelopeShape,
  })
  .strict();

export const launchResultSpectatorEventSchema = z
  .object({
    type: z.literal("launch.result.spectator"),
    ...battleCorrelationShape,
    player1: launchResultSchema,
    player2: launchResultSchema,
    ...serverEnvelopeShape,
  })
  .strict();

export const BATTLE_POSITION_MIN_MM = -100;
export const BATTLE_POSITION_MAX_MM = 100;
export const BATTLE_ANGLE_MIN_RAD = -Math.PI;
export const BATTLE_ANGLE_MAX_RAD = Math.PI;
export const BATTLE_ANGULAR_SPEED_MIN = -1_000;
export const BATTLE_ANGULAR_SPEED_MAX = 1_000;

export const battleBodySchema = z
  .object({
    x: finiteNumberSchema.min(BATTLE_POSITION_MIN_MM).max(BATTLE_POSITION_MAX_MM),
    y: finiteNumberSchema.min(BATTLE_POSITION_MIN_MM).max(BATTLE_POSITION_MAX_MM),
    angle: finiteNumberSchema.min(BATTLE_ANGLE_MIN_RAD).max(BATTLE_ANGLE_MAX_RAD),
    angularSpeed: finiteNumberSchema
      .min(BATTLE_ANGULAR_SPEED_MIN)
      .max(BATTLE_ANGULAR_SPEED_MAX),
  })
  .strict();
export type BattleBody = z.infer<typeof battleBodySchema>;

export const battleFrameEventSchema = z
  .object({
    type: z.literal("battle.frame"),
    ...battleCorrelationShape,
    sequence: safeNonnegativeIntegerSchema,
    tick: safeNonnegativeIntegerSchema,
    player1: battleBodySchema,
    player2: battleBodySchema,
    ...serverEnvelopeShape,
  })
  .strict();

export const roundWinnerSchema = z.enum(["player1", "player2", "draw"]);
export type RoundWinner = z.infer<typeof roundWinnerSchema>;

export const matchRoundWinnerSchema = z.enum(["player1", "player2"]);
export type MatchRoundWinner = z.infer<typeof matchRoundWinnerSchema>;

export const battleCheckpointEventSchema = z.object({
  type: z.literal("battle.checkpoint"),
  roomId: correlationIdSchema,
  matchId: correlationIdSchema,
  roundId: correlationIdSchema,
  attempt: z.number().int().min(1).max(1_000),
  phase: z.enum(["launch", "battle", "result"]),
  roundWinners: z.array(matchRoundWinnerSchema).max(3),
  ...serverEnvelopeShape,
}).strict();
export type BattleCheckpointEvent = z.infer<typeof battleCheckpointEventSchema>;

export const roundFinishedEventSchema = z
  .object({
    type: z.literal("round.finished"),
    ...battleCorrelationShape,
    winner: roundWinnerSchema,
    ...serverEnvelopeShape,
  })
  .strict();

const SCORE_TOLERANCE = 1e-9;

export const matchScoreSchema = z
  .object({
    battlePoints: z.number().int().min(0).max(2),
    challengePoints: z.number().finite().min(0).max(0.5),
    total: nonnegativeFiniteNumberSchema,
  })
  .strict()
  .superRefine((score, context) => {
    const expectedTotal = score.battlePoints + score.challengePoints;
    if (Math.abs(score.total - expectedTotal) > SCORE_TOLERANCE) {
      context.addIssue({
        code: "custom",
        message: "Total must equal battle points plus challenge points",
        path: ["total"],
      });
    }
  });
export type MatchScore = z.infer<typeof matchScoreSchema>;

export const matchFinishedEventSchema = z
  .object({
    type: z.literal("match.finished"),
    roomId: correlationIdSchema,
    matchId: correlationIdSchema,
    player1: matchScoreSchema,
    player2: matchScoreSchema,
    roundWinners: z.array(matchRoundWinnerSchema).min(2).max(3),
    ...serverEnvelopeShape,
  })
  .strict()
  .superRefine((match, context) => {
    const player1Wins = match.roundWinners.filter((winner) => winner === "player1").length;
    const player2Wins = match.roundWinners.length - player1Wins;
    const completed = player1Wins === 2 || player2Wins === 2;
    const endedEarly =
      match.roundWinners.length === 3 && match.roundWinners[0] === match.roundWinners[1];

    if (!completed || endedEarly) {
      context.addIssue({
        code: "custom",
        message: "Round winners must describe a completed best-of-three match",
        path: ["roundWinners"],
      });
    }
    if (
      match.player1.battlePoints !== player1Wins ||
      match.player2.battlePoints !== player2Wins
    ) {
      context.addIssue({
        code: "custom",
        message: "Battle points must match the round winner counts",
        path: ["roundWinners"],
      });
    }
    if (match.player1.challengePoints > 0 && match.player2.challengePoints > 0) {
      context.addIssue({
        code: "custom",
        message: "At most one player may receive challenge points",
        path: ["player2", "challengePoints"],
      });
    }
  });

export const matchCancelledEventSchema = z.object({
  type: z.literal("match.cancelled"),
  roomId: correlationIdSchema,
  matchId: correlationIdSchema,
  reason: z.enum(["attempt-limit", "server-error"]),
  ...serverEnvelopeShape,
}).strict();
export type MatchCancelledEvent = z.infer<typeof matchCancelledEventSchema>;

export const commandAckEventSchema = z
  .object({
    type: z.literal("command.ack"),
    causedByEventId: eventIdSchema,
    status: z.enum(["applied", "replayed"]),
    resultServerEventId: eventIdSchema.nullable().optional(),
    ...serverEnvelopeShape,
  })
  .strict();

export const errorEventSchema = z
  .object({
    type: z.literal("error"),
    code: z.string().trim().min(1).max(64),
    message: z.string().trim().min(1).max(500),
    causedByEventId: eventIdSchema.optional(),
    ...serverEnvelopeShape,
  })
  .strict();

export const clockPongEventSchema = z.object({
  type: z.literal("clock.pong"),
  pingId: correlationIdSchema,
  clientSendTimeMs: safeNonnegativeIntegerSchema,
  serverReceiveTimeMs: safeNonnegativeIntegerSchema,
  serverSendTimeMs: safeNonnegativeIntegerSchema,
  ...serverEnvelopeShape,
}).strict();

export const roomDepartedEventSchema = z.object({
  type: z.literal("room.departed"),
  roomId: correlationIdSchema,
  reason: z.enum(["left", "closed", "expired", "removed"]),
  ...serverEnvelopeShape,
}).strict();

export const serverEventSchema = z.discriminatedUnion("type", [
  protocolWelcomeEventSchema,
  lobbySnapshotEventSchema,
  roomSnapshotEventSchema,
  roomDeltaEventSchema,
  launchScheduleEventSchema,
  battleStartedEventSchema,
  battleCheckpointEventSchema,
  launchResultPrivateEventSchema,
  launchResultSpectatorEventSchema,
  battleFrameEventSchema,
  roundFinishedEventSchema,
  matchFinishedEventSchema,
  matchCancelledEventSchema,
  commandAckEventSchema,
  clockPongEventSchema,
  roomDepartedEventSchema,
  errorEventSchema,
]);
export type ServerEvent = z.infer<typeof serverEventSchema>;

export const playerServerEventSchema = z.discriminatedUnion("type", [
  protocolWelcomeEventSchema,
  lobbySnapshotEventSchema,
  roomSnapshotEventSchema,
  roomDeltaEventSchema,
  launchScheduleEventSchema,
  battleStartedEventSchema,
  battleCheckpointEventSchema,
  launchResultPrivateEventSchema,
  battleFrameEventSchema,
  roundFinishedEventSchema,
  matchFinishedEventSchema,
  matchCancelledEventSchema,
  commandAckEventSchema,
  clockPongEventSchema,
  roomDepartedEventSchema,
  errorEventSchema,
]);
export type PlayerServerEvent = z.infer<typeof playerServerEventSchema>;

export const spectatorServerEventSchema = z.discriminatedUnion("type", [
  protocolWelcomeEventSchema,
  lobbySnapshotEventSchema,
  roomSnapshotEventSchema,
  roomDeltaEventSchema,
  launchScheduleEventSchema,
  battleStartedEventSchema,
  battleCheckpointEventSchema,
  launchResultSpectatorEventSchema,
  battleFrameEventSchema,
  roundFinishedEventSchema,
  matchFinishedEventSchema,
  matchCancelledEventSchema,
  commandAckEventSchema,
  clockPongEventSchema,
  roomDepartedEventSchema,
  errorEventSchema,
]);
export type SpectatorServerEvent = z.infer<typeof spectatorServerEventSchema>;

export type ProtocolWelcomeEvent = z.infer<typeof protocolWelcomeEventSchema>;
export type ProtocolUnsupportedEvent = z.infer<typeof protocolUnsupportedEventSchema>;
export type LobbySnapshotEvent = z.infer<typeof lobbySnapshotEventSchema>;
export type RoomSnapshotEvent = z.infer<typeof roomSnapshotEventSchema>;
export type RoomDeltaEvent = z.infer<typeof roomDeltaEventSchema>;
export type LaunchScheduleEvent = z.infer<typeof launchScheduleEventSchema>;
export type LaunchResultPrivateEvent = z.infer<typeof launchResultPrivateEventSchema>;
export type LaunchResultSpectatorEvent = z.infer<typeof launchResultSpectatorEventSchema>;
export type BattleFrameEvent = z.infer<typeof battleFrameEventSchema>;
export type RoundFinishedEvent = z.infer<typeof roundFinishedEventSchema>;
export type MatchFinishedEvent = z.infer<typeof matchFinishedEventSchema>;
export type CommandAckEvent = z.infer<typeof commandAckEventSchema>;
export type ClockPongEvent = z.infer<typeof clockPongEventSchema>;
export type RoomDepartedEvent = z.infer<typeof roomDepartedEventSchema>;
export type ErrorEvent = z.infer<typeof errorEventSchema>;
