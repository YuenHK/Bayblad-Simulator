import { describe, expect, it } from "vitest";
import {
  BATTLE_ANGLE_MAX_RAD,
  BATTLE_ANGLE_MIN_RAD,
  BATTLE_ANGULAR_SPEED_MAX,
  BATTLE_ANGULAR_SPEED_MIN,
  BATTLE_POSITION_MAX_MM,
  BATTLE_POSITION_MIN_MM,
  deriveViewerState,
  LAUNCH_MULTIPLIER_MAX,
  LAUNCH_MULTIPLIER_MIN,
  clientEventSchema,
  handshakeServerEventSchema,
  playerServerEventSchema,
  protocolHelloEventSchema,
  protocolUnsupportedEventSchema,
  serverEventSchema,
  spectatorServerEventSchema,
  v1CommandEventSchema,
  adminAnalyticsSummarySchema,
  adminRecordsPageSchema,
} from "./events";

const eventId = "550e8400-e29b-41d4-a716-446655440000";
const serverEventId = "8db11fe0-aca6-45d8-8cf3-13fd42232885";
const resultServerEventId = "725b3e05-d270-4f9f-8327-45dd5a9fc92e";
const designId = "7d9e2c75-2ef5-4ea7-aac2-18f385c1f82a";
const clientEnvelope = { protocolVersion: 1, eventId } as const;
const serverEnvelope = { protocolVersion: 1, serverEventId } as const;

describe("admin DTO schemas", () => {
  it("rejects legacy analytics field names and accepts the authoritative summary", () => {
    expect(
      adminAnalyticsSummarySchema.safeParse({
        usagePeriods: { daily: [{ period: "2026-08-29", matches: 1 }] },
      }).success,
    ).toBe(false);
    const value = {
      filters: { from: "2026-08-01", to: "2026-08-29" },
      filterApplicability: {},
      usage: [],
      usagePeriods: {
        daily: [
          {
            date: "2026-08-29",
            activeDevices: 1,
            designs: 2,
            rooms: 3,
            completedMatches: 4,
            shapes: [],
          },
        ],
        weekly: [],
        monthly: [],
      },
      parameterUsage: [
        {
          scope: "allEligibleDesigns",
          dimension: "layerShape",
          value: { position: "top", shape: "circle" },
          count: 2,
          proportion: 1,
          performanceModelVersion: "1",
          totalGroups: 1,
          truncated: false,
          population: 2,
        },
      ],
      parameters: [],
      rankings: {
        top: [
          {
            dimension: "layerShape",
            value: { shape: "circle" },
            launchGrade: "Perfect",
            opponentStrengthBand: "low",
            performanceModelVersion: "1",
            physicsModelVersion: "2",
            totalGroups: 1,
            sampleSize: 10,
            participantObservations: 10,
            averageScore: 2,
            winRate: 0.5,
            opponentAverageStrength: 50,
            expectedWinRate: 0.5,
            outcomeResidual: 0,
            gradeOccurrenceCount: 10,
          },
        ],
        bottom: [],
        total: 1,
        hasMore: false,
        snapshotCursor: "cursor",
        overallLaunchDistribution: {
          Perfect: 1,
          Great: 2,
          Good: 3,
          Miss: 4,
          totalOccurrences: 10,
        },
      },
      refreshedAt: "2026-08-29T00:00:00.000Z",
    };
    expect(adminAnalyticsSummarySchema.safeParse(value).success).toBe(true);
  });
  it("requires a unique match-slot key and typed full design parameters", () => {
    expect(
      adminRecordsPageSchema.safeParse({
        rows: [{ id: "match", totalScore: 2 }],
        total: 1,
        page: 1,
        pageSize: 25,
      }).success,
    ).toBe(false);
  });
});

const clientCases = [
  {
    type: "protocol.hello",
    valid: { type: "protocol.hello", eventId, supportedVersions: [1] },
    invalid: { type: "protocol.hello", eventId, supportedVersions: [] },
  },
  {
    type: "room.create",
    valid: { type: "room.create", name: "  測試房  ", ...clientEnvelope },
    invalid: { type: "room.create", name: " ", ...clientEnvelope },
  },
  {
    type: "room.join",
    valid: {
      type: "room.join",
      roomId: "room-1",
      role: "spectator",
      ...clientEnvelope,
    },
    invalid: {
      type: "room.join",
      roomId: "room-1",
      role: "owner",
      ...clientEnvelope,
    },
  },
  {
    type: "room.move",
    valid: {
      type: "room.move",
      roomId: "room-1",
      target: "player1",
      ...clientEnvelope,
    },
    invalid: {
      type: "room.move",
      roomId: "room-1",
      target: "player3",
      ...clientEnvelope,
    },
  },
  {
    type: "player.ready",
    valid: {
      type: "player.ready",
      roomId: "room-1",
      designId,
      ...clientEnvelope,
    },
    invalid: {
      type: "player.ready",
      roomId: "room-1",
      designId: "not-a-uuid",
      ...clientEnvelope,
    },
  },
  {
    type: "launch.tap",
    valid: {
      type: "launch.tap",
      roomId: "room-1",
      roundId: "round-1",
      nonce: "nonce-1",
      clientTimeMs: 1_000,
      ...clientEnvelope,
    },
    invalid: {
      type: "launch.tap",
      roomId: "room-1",
      roundId: "round-1",
      nonce: "nonce-1",
      clientTimeMs: 1_000.5,
      ...clientEnvelope,
    },
  },
  {
    type: "clock.ping",
    valid: {
      type: "clock.ping",
      pingId: "ping-1",
      clientSentAtMs: 1_000,
      ...clientEnvelope,
    },
    invalid: {
      type: "clock.ping",
      pingId: "",
      clientSentAtMs: -1,
      ...clientEnvelope,
    },
  },
  {
    type: "clock.ack",
    valid: { type: "clock.ack", pingId: "ping-1", ...clientEnvelope },
    invalid: { type: "clock.ack", pingId: "", ...clientEnvelope },
  },
  {
    type: "room.departed.ack",
    valid: {
      type: "room.departed.ack",
      departureId: eventId,
      ...clientEnvelope,
    },
    invalid: {
      type: "room.departed.ack",
      departureId: "not-a-uuid",
      ...clientEnvelope,
    },
  },
  {
    type: "room.leave",
    valid: { type: "room.leave", roomId: "room-1", ...clientEnvelope },
    invalid: { type: "room.leave", roomId: "", ...clientEnvelope },
  },
  {
    type: "room.close",
    valid: { type: "room.close", roomId: "room-1", ...clientEnvelope },
    invalid: { type: "room.close", roomId: "", ...clientEnvelope },
  },
] as const;

describe("clientEventSchema", () => {
  it.each(clientCases)("accepts a valid $type event", ({ valid }) => {
    expect(clientEventSchema.safeParse(valid).success).toBe(true);
  });

  it.each(clientCases)("rejects an invalid $type event", ({ invalid }) => {
    expect(clientEventSchema.safeParse(invalid).success).toBe(false);
  });

  it("rejects ready without a design id", () => {
    expect(
      clientEventSchema.safeParse({
        type: "player.ready",
        roomId: "room-1",
        ...clientEnvelope,
      }).success,
    ).toBe(false);
  });

  it("accepts a spectator join", () => {
    expect(
      clientEventSchema.safeParse({
        type: "room.join",
        roomId: "room-1",
        role: "spectator",
        ...clientEnvelope,
      }).success,
    ).toBe(true);
  });

  it("trims room names", () => {
    expect(
      clientEventSchema.parse({
        type: "room.create",
        name: "  測試房  ",
        ...clientEnvelope,
      }),
    ).toMatchObject({ name: "測試房" });
  });

  it("supports self moves and owner-directed moves", () => {
    const move = {
      type: "room.move",
      roomId: "room-1",
      target: "spectator",
      ...clientEnvelope,
    };
    expect(clientEventSchema.safeParse(move).success).toBe(true);
    expect(
      clientEventSchema.safeParse({ ...move, subjectParticipantId: "p2" })
        .success,
    ).toBe(true);
    expect(
      clientEventSchema.safeParse({
        ...move,
        subjectParticipantId: "x".repeat(33),
      }).success,
    ).toBe(false);
  });

  it("requires protocol version 1 on commands", () => {
    const close = clientCases[10].valid;
    const { protocolVersion: _version, ...withoutVersion } = close;
    expect(clientEventSchema.safeParse(withoutVersion).success).toBe(false);
    expect(
      clientEventSchema.safeParse({ ...close, protocolVersion: 2 }).success,
    ).toBe(false);
  });

  it("only negotiates the supported protocol version", () => {
    expect(
      clientEventSchema.safeParse({
        type: "protocol.hello",
        eventId,
        supportedVersions: [2],
      }).success,
    ).toBe(true);
  });

  it("bounds and deduplicates advertised protocol versions", () => {
    for (const supportedVersions of [
      [1, 1],
      [1, 2, 3, 4, 5, 6, 7, 8, 9],
      [0],
      [256],
      [Number.MAX_SAFE_INTEGER + 1],
      [1.5],
    ]) {
      expect(
        protocolHelloEventSchema.safeParse({
          type: "protocol.hello",
          eventId,
          supportedVersions,
        }).success,
      ).toBe(false);
    }
  });

  it("keeps handshake and v1 command schemas mutually exclusive", () => {
    const hello = {
      type: "protocol.hello",
      eventId,
      supportedVersions: [1, 2],
    };
    const command = clientCases[6].valid;
    expect(protocolHelloEventSchema.safeParse(hello).success).toBe(true);
    expect(v1CommandEventSchema.safeParse(hello).success).toBe(false);
    expect(v1CommandEventSchema.safeParse(command).success).toBe(true);
    expect(protocolHelloEventSchema.safeParse(command).success).toBe(false);
  });

  it("requires a UUID event id and rejects unknown fields", () => {
    const close = clientCases[8].valid;
    expect(
      clientEventSchema.safeParse({ ...close, eventId: "event-1" }).success,
    ).toBe(false);
    expect(
      clientEventSchema.safeParse({ ...close, unexpected: true }).success,
    ).toBe(false);
  });

  it("bounds command identifiers", () => {
    const join = clientCases[2].valid;
    expect(
      clientEventSchema.safeParse({ ...join, roomId: "x".repeat(129) }).success,
    ).toBe(false);
    const tap = clientCases[5].valid;
    for (const field of ["roundId", "nonce"] as const) {
      expect(
        clientEventSchema.safeParse({ ...tap, [field]: "x".repeat(129) })
          .success,
      ).toBe(false);
    }
  });

  it("rejects malicious client timestamps", () => {
    const tap = clientCases[5].valid;
    for (const clientTimeMs of [
      -1,
      1.5,
      Number.MAX_SAFE_INTEGER + 1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ]) {
      expect(
        clientEventSchema.safeParse({ ...tap, clientTimeMs }).success,
      ).toBe(false);
    }
  });

  it("拒絕客戶端偽造任何 server clock fields", () => {
    const ping = clientCases[6].valid;
    expect(
      clientEventSchema.safeParse({
        ...ping,
        serverReceiveTimeMs: 1,
        serverSendTimeMs: 2,
      }).success,
    ).toBe(false);
    expect(
      clientEventSchema.safeParse({
        ...ping,
        previousSample: { serverReceivedAtMs: 1 },
      }).success,
    ).toBe(false);
  });

  it("normalizes safe public room names and rejects dangerous controls", () => {
    const create = clientCases[1].valid;
    expect(
      clientEventSchema.parse({ ...create, name: "  Cafe\u0301 🌟  " }),
    ).toMatchObject({ name: "Café 🌟" });

    for (const name of [
      "line\nbreak",
      "hidden\u0085control",
      "safe\u202ename",
      "x\u2066y",
    ]) {
      expect(clientEventSchema.safeParse({ ...create, name }).success).toBe(
        false,
      );
    }
    expect(
      clientEventSchema.safeParse({ ...create, name: "繁體中文 🌀" }).success,
    ).toBe(true);
  });
});

const occupiedSeat = {
  participantId: "p1",
  displayName: "Player 1",
  ready: true,
  designId,
};

const launchPlayer = {
  participantId: "p1",
  displayName: "Player 1",
  grade: "Perfect",
  angularMultiplier: 1.1,
  impulseMultiplier: 1.1,
};

const lobbySnapshot = {
  type: "lobby.snapshot",
  revision: 4,
  rooms: [
    {
      id: "room-1",
      code: "A102",
      name: "測試房",
      phase: "waiting",
      player1: { displayName: "Player 1" },
      player2: { displayName: null },
      spectatorCount: 3,
    },
  ],
  ...serverEnvelope,
} as const;

const roomSnapshot = {
  type: "room.snapshot",
  roomId: "room-1",
  code: "A102",
  name: "測試房",
  ownerParticipantId: "p1",
  phase: "launch",
  revision: 8,
  player1: occupiedSeat,
  player2: null,
  spectators: [{ participantId: "s1", displayName: "Spectator" }],
  viewer: { participantId: "p1", isOwner: true, role: "player1" },
  ...serverEnvelope,
} as const;

const launchSchedule = {
  type: "launch.schedule",
  roomId: "room-1",
  matchId: "match-1",
  roundId: "round-1",
  serverTargetTimeMs: 1_000,
  serverDeadlineTimeMs: 2_500,
  nonce: "nonce-1",
  ...serverEnvelope,
} as const;

const launchPrivate = {
  type: "launch.result.private",
  roomId: "room-1",
  matchId: "match-1",
  roundId: "round-1",
  participantId: "p1",
  grade: "Great",
  angularMultiplier: 1,
  impulseMultiplier: 1,
  ...serverEnvelope,
} as const;

const battleFrame = {
  type: "battle.frame",
  roomId: "room-1",
  matchId: "match-1",
  roundId: "round-1",
  sequence: 12,
  tick: 12,
  player1: { x: 1, y: 2, angle: 0.5, angularSpeed: 10 },
  player2: { x: 3, y: 4, angle: 0.75, angularSpeed: 9 },
  ...serverEnvelope,
} as const;

const matchFinished = {
  type: "match.finished",
  roomId: "room-1",
  matchId: "match-1",
  player1: { battlePoints: 1, challengePoints: 0.5, total: 1.5 },
  player2: { battlePoints: 2, challengePoints: 0, total: 2 },
  roundWinners: ["player1", "player2", "player2"],
  ...serverEnvelope,
} as const;

const serverCases = [
  {
    type: "protocol.welcome",
    value: { type: "protocol.welcome", selectedVersion: 1, ...serverEnvelope },
  },
  { type: "lobby.snapshot", value: lobbySnapshot },
  { type: "room.snapshot", value: roomSnapshot },
  {
    type: "room.delta",
    value: {
      type: "room.delta",
      roomId: "room-1",
      baseRevision: 8,
      revision: 9,
      patch: {
        ownerParticipantId: "p1",
        phase: "waiting",
        player2: {
          participantId: "s1",
          displayName: "Spectator",
          ready: false,
          designId: null,
        },
        spectatorCount: 0,
        name: "更新房間",
      },
      joined: [],
      leftParticipantIds: ["s1"],
      ...serverEnvelope,
    },
  },
  { type: "launch.schedule", value: launchSchedule },
  { type: "launch.result.private", value: launchPrivate },
  {
    type: "launch.result.spectator",
    value: {
      type: "launch.result.spectator",
      roomId: "room-1",
      matchId: "match-1",
      roundId: "round-1",
      player1: launchPlayer,
      player2: {
        ...launchPlayer,
        participantId: "p2",
        displayName: "Player 2",
        grade: "Good",
      },
      ...serverEnvelope,
    },
  },
  { type: "battle.frame", value: battleFrame },
  {
    type: "round.finished",
    value: {
      type: "round.finished",
      roomId: "room-1",
      matchId: "match-1",
      roundId: "round-1",
      winner: "draw",
      ...serverEnvelope,
    },
  },
  { type: "match.finished", value: matchFinished },
  {
    type: "command.ack",
    value: {
      type: "command.ack",
      causedByEventId: eventId,
      commandType: "room.create",
      status: "applied",
      resultServerEventId,
      ...serverEnvelope,
    },
  },
  {
    type: "error",
    value: {
      type: "error",
      code: "ROOM_CLOSED",
      message: "Room closed",
      causedByEventId: eventId,
      ...serverEnvelope,
    },
  },
] as const;

const maximumParticipantId = "p".repeat(32);
const maximumDisplayName = "觀".repeat(80);
const maximumSpectators = Array.from({ length: 500 }, (_, index) => ({
  participantId: `s${index}`.padEnd(32, "x"),
  displayName: maximumDisplayName,
}));
const maximumRoomSnapshot = {
  ...roomSnapshot,
  name: "房".repeat(30),
  ownerParticipantId: maximumParticipantId,
  player1: {
    ...occupiedSeat,
    participantId: maximumParticipantId,
    displayName: maximumDisplayName,
  },
  spectators: maximumSpectators,
  viewer: {
    ...roomSnapshot.viewer,
    participantId: maximumParticipantId,
  },
};

const unsupportedEvent = {
  type: "protocol.unsupported",
  serverEventId,
  supportedVersions: [1],
  causedByEventId: eventId,
  reason: "No mutually supported protocol version",
} as const;

describe("handshake server events", () => {
  it("responds to a valid v2-only hello without using the v1 envelope", () => {
    expect(
      protocolHelloEventSchema.safeParse({
        type: "protocol.hello",
        eventId,
        supportedVersions: [2],
      }).success,
    ).toBe(true);
    expect(
      protocolUnsupportedEventSchema.safeParse(unsupportedEvent).success,
    ).toBe(true);
    expect(handshakeServerEventSchema.safeParse(unsupportedEvent).success).toBe(
      true,
    );
    expect(
      handshakeServerEventSchema.safeParse(serverCases[0].value).success,
    ).toBe(true);
    expect(serverEventSchema.safeParse(unsupportedEvent).success).toBe(false);
    expect(playerServerEventSchema.safeParse(unsupportedEvent).success).toBe(
      false,
    );
    expect(spectatorServerEventSchema.safeParse(unsupportedEvent).success).toBe(
      false,
    );
  });

  it("keeps unsupported responses strict, bounded, and version neutral", () => {
    expect(
      protocolUnsupportedEventSchema.safeParse({
        ...unsupportedEvent,
        protocolVersion: 1,
      }).success,
    ).toBe(false);
    for (const supportedVersions of [[], [1, 1], Array(9).fill(1), [2]]) {
      expect(
        protocolUnsupportedEventSchema.safeParse({
          ...unsupportedEvent,
          supportedVersions,
        }).success,
      ).toBe(false);
    }
    for (const reason of [
      "bad\nreason",
      "bad\u0085reason",
      "bad\u202ereason",
      "x".repeat(161),
    ]) {
      expect(
        protocolUnsupportedEventSchema.safeParse({
          ...unsupportedEvent,
          reason,
        }).success,
      ).toBe(false);
    }
    expect(
      protocolUnsupportedEventSchema.safeParse({
        ...unsupportedEvent,
        reason: "  版本不支援 🚫  ",
      }).success,
    ).toBe(true);
  });
});

describe("serverEventSchema", () => {
  it("reports persistence progress without exposing match scores", () => {
    const roomId = "room-1";
    const matchId = "match-1";
    for (const value of [
      {
        type: "match.persistence",
        roomId,
        matchId,
        status: "saving",
        attempt: 1,
        protocolVersion: 1,
        serverEventId,
      },
      {
        type: "match.persistence_failed",
        roomId,
        matchId,
        failureCode: "MATCH_SAVE_FAILED",
        retryable: true,
        protocolVersion: 1,
        serverEventId,
      },
    ]) {
      const parsed = serverEventSchema.parse(value);
      expect(parsed).not.toHaveProperty("player1");
      expect(parsed).not.toHaveProperty("player2");
      expect(parsed).not.toHaveProperty("roundWinners");
    }
  });
  it("接受 strict clock.pong 與 authoritative room.departed", () => {
    expect(
      serverEventSchema.safeParse({
        type: "clock.pong",
        pingId: "ping-1",
        clientSentAtMs: 1_000,
        serverReceiveTimeMs: 6_025,
        serverSendTimeMs: 6_026,
        ...serverEnvelope,
      }).success,
    ).toBe(true);
    expect(
      serverEventSchema.safeParse({
        type: "room.departed",
        departureId: clientEnvelope.eventId,
        roomId: "room-1",
        reason: "closed",
        ...serverEnvelope,
      }).success,
    ).toBe(true);
    expect(
      serverEventSchema.safeParse({
        type: "room.departed",
        departureId: clientEnvelope.eventId,
        roomId: "room-1",
        reason: "unknown",
        ...serverEnvelope,
      }).success,
    ).toBe(false);
  });
  it.each(serverCases)("accepts a valid $type event", ({ value }) => {
    expect(serverEventSchema.safeParse(value).success).toBe(true);
  });

  it.each(serverCases)(
    "requires the v1 server envelope for $type",
    ({ value }) => {
      const { protocolVersion: _version, ...withoutVersion } = value;
      expect(serverEventSchema.safeParse(withoutVersion).success).toBe(false);
      expect(
        serverEventSchema.safeParse({ ...value, protocolVersion: 2 }).success,
      ).toBe(false);
      const { serverEventId: _id, ...withoutId } = value;
      expect(serverEventSchema.safeParse(withoutId).success).toBe(false);
    },
  );

  it("requires a valid welcome version", () => {
    expect(
      serverEventSchema.safeParse({
        type: "protocol.welcome",
        selectedVersion: 2,
        ...serverEnvelope,
      }).success,
    ).toBe(false);
  });

  it("allows welcome to return an opaque resumable session token without exposing identity ids", () => {
    const welcome = serverEventSchema.parse({
      type: "protocol.welcome",
      selectedVersion: 1,
      sessionToken: "opaque-resume-token-with-sufficient-entropy",
      sessionStatus: "resumed",
      ...serverEnvelope,
    });
    expect(welcome).toMatchObject({
      sessionToken: "opaque-resume-token-with-sufficient-entropy",
    });
    expect(
      serverEventSchema.safeParse({ ...welcome, sessionToken: "short" })
        .success,
    ).toBe(false);
  });

  it("strictly exposes battle visual designs without internal ownership or performance", () => {
    const layer = (position: "top" | "middle" | "bottom", id: string) => ({
      id,
      position,
      shape: "circle",
      points: 6,
      diameterMm: 40,
      cornerRoundness: 0.5,
      rotationDeg: 0,
      color: "#2563eb",
    });
    const design = {
      layers: [
        layer("top", "top"),
        layer("middle", "middle"),
        layer("bottom", "bottom"),
      ],
      screwLayout: { count: 4, radiusMm: 15, rotationDeg: 0 },
      metalDiscDiameterMm: 0,
    };
    const started = {
      type: "battle.started",
      roomId: "room-1",
      matchId: "match-1",
      player1: { participantId: "p1", designId, design },
      player2: { participantId: "p2", designId, design },
      ...serverEnvelope,
    };
    expect(serverEventSchema.safeParse(started).success).toBe(true);
    expect(
      serverEventSchema.safeParse({
        ...started,
        player1: { ...started.player1, ownerSessionId: "secret" },
      }).success,
    ).toBe(false);
  });

  it("defines acknowledgement correlation without implementing idempotency", () => {
    const ack = serverCases[10].value;
    expect(serverEventSchema.safeParse(ack).success).toBe(true);
    expect(
      serverEventSchema.safeParse({
        ...ack,
        status: "replayed",
        resultServerEventId: null,
      }).success,
    ).toBe(true);
    const { resultServerEventId: _resultId, ...withoutResultId } = ack;
    expect(serverEventSchema.safeParse(withoutResultId).success).toBe(true);
    const { commandType: _commandType, ...withoutCommandType } = ack;
    expect(serverEventSchema.safeParse(withoutCommandType).success).toBe(false);
    expect(
      serverEventSchema.safeParse({ ...ack, causedByEventId: "not-a-uuid" })
        .success,
    ).toBe(false);
    expect(
      serverEventSchema.safeParse({ ...ack, commandType: "unknown.command" })
        .success,
    ).toBe(false);
  });

  it("prevents opponent launch data leaking in private results", () => {
    expect(
      serverEventSchema.safeParse({ ...launchPrivate, opponentGrade: "Miss" })
        .success,
    ).toBe(false);
    expect(
      serverEventSchema.safeParse({ ...launchPrivate, opponent: launchPlayer })
        .success,
    ).toBe(false);
  });

  it("does not expose internal identity ids", () => {
    expect(
      serverEventSchema.safeParse({
        ...roomSnapshot,
        ownerId: "internal-owner",
      }).success,
    ).toBe(false);
    expect(
      serverEventSchema.safeParse({
        ...roomSnapshot,
        spectators: [
          { participantId: "s1", displayName: "Spectator", userId: "db-1" },
        ],
      }).success,
    ).toBe(false);
    expect(
      serverEventSchema.safeParse({ ...launchPrivate, userId: "db-1" }).success,
    ).toBe(false);
  });

  it("normalizes safe display names and rejects display-name controls", () => {
    expect(
      serverEventSchema.parse({
        ...roomSnapshot,
        player1: { ...occupiedSeat, displayName: "Cafe\u0301 🌟" },
      }),
    ).toMatchObject({ player1: { displayName: "Café 🌟" } });

    for (const displayName of [
      "bad\nname",
      "bad\u009fname",
      "bad\u202dname",
      "bad\u2069name",
    ]) {
      expect(
        serverEventSchema.safeParse({
          ...roomSnapshot,
          spectators: [{ participantId: "s1", displayName }],
        }).success,
      ).toBe(false);
    }
    expect(
      serverEventSchema.safeParse({
        ...roomSnapshot,
        spectators: [{ participantId: "s1", displayName: "學生 🪀" }],
      }).success,
    ).toBe(true);
  });

  it("keeps spectator names out of lobby snapshots", () => {
    expect(
      serverEventSchema.safeParse({
        ...lobbySnapshot,
        rooms: [
          {
            ...lobbySnapshot.rooms[0],
            spectators: [{ displayName: "Hidden" }],
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("represents an empty seat as null", () => {
    expect(serverEventSchema.safeParse(roomSnapshot).success).toBe(true);
    expect(
      serverEventSchema.safeParse({
        ...roomSnapshot,
        player2: {
          participantId: null,
          displayName: null,
          ready: null,
          designId: null,
        },
      }).success,
    ).toBe(false);
  });

  it("requires a design when an occupied seat is ready", () => {
    expect(
      serverEventSchema.safeParse({
        ...roomSnapshot,
        player1: { ...occupiedSeat, designId: null },
      }).success,
    ).toBe(false);
    expect(
      serverEventSchema.safeParse({
        ...roomSnapshot,
        player1: { ...occupiedSeat, ready: false, designId: null },
      }).success,
    ).toBe(true);
  });

  it("requires unique room participants and a role-matched viewer", () => {
    const invalidSnapshots = [
      {
        ...roomSnapshot,
        player2: { ...occupiedSeat, participantId: "p1" },
      },
      {
        ...roomSnapshot,
        spectators: [{ participantId: "p1", displayName: "Duplicate" }],
      },
      {
        ...roomSnapshot,
        viewer: { ...roomSnapshot.viewer, participantId: "missing" },
      },
      {
        ...roomSnapshot,
        viewer: { ...roomSnapshot.viewer, role: "spectator" },
      },
      {
        ...roomSnapshot,
        viewer: { ...roomSnapshot.viewer, isOwner: false },
      },
      {
        ...roomSnapshot,
        ownerParticipantId: "disconnected-owner",
        viewer: { ...roomSnapshot.viewer, isOwner: true },
      },
    ];
    for (const snapshot of invalidSnapshots) {
      expect(serverEventSchema.safeParse(snapshot).success).toBe(false);
    }

    expect(
      serverEventSchema.safeParse({
        ...roomSnapshot,
        ownerParticipantId: "disconnected-owner",
        viewer: { ...roomSnapshot.viewer, isOwner: false },
      }).success,
    ).toBe(true);
  });

  it("requires internally consistent presence deltas", () => {
    const delta = serverCases[3].value;
    const joined = { participantId: "s2", displayName: "New Spectator" };
    expect(
      serverEventSchema.safeParse({
        ...delta,
        joined: [joined, joined],
      }).success,
    ).toBe(false);
    expect(
      serverEventSchema.safeParse({
        ...delta,
        leftParticipantIds: ["s1", "s1"],
      }).success,
    ).toBe(false);
    expect(
      serverEventSchema.safeParse({
        ...delta,
        joined: [joined],
        leftParticipantIds: ["s2"],
      }).success,
    ).toBe(false);
  });

  it("expresses an atomic room move without transmitting viewer identity", () => {
    const sharedDelta = serverCases[3].value;
    expect(serverEventSchema.safeParse(sharedDelta).success).toBe(true);
    expect(sharedDelta.patch.player2?.participantId).toBe("s1");
    expect(sharedDelta.leftParticipantIds).toEqual(["s1"]);
    expect(
      new TextEncoder().encode(JSON.stringify(sharedDelta)).byteLength,
    ).toBeLessThan(2_048);
    expect(
      serverEventSchema.safeParse({
        ...sharedDelta,
        patch: {},
        joined: [],
        leftParticipantIds: [],
      }).success,
    ).toBe(false);
    expect(
      serverEventSchema.safeParse({
        ...sharedDelta,
        patch: { phase: undefined },
        joined: [],
        leftParticipantIds: [],
      }).success,
    ).toBe(false);
    expect(
      serverEventSchema.safeParse({
        ...sharedDelta,
        patch: { ...sharedDelta.patch, spectators: roomSnapshot.spectators },
      }).success,
    ).toBe(false);
    expect(
      serverEventSchema.safeParse({
        ...sharedDelta,
        viewer: roomSnapshot.viewer,
      }).success,
    ).toBe(false);
    expect(
      serverEventSchema.safeParse({
        ...sharedDelta,
        type: "room.presence.delta",
      }).success,
    ).toBe(false);
    expect(
      serverEventSchema.safeParse({ ...sharedDelta, type: "room.state.delta" })
        .success,
    ).toBe(false);
    expect(
      serverEventSchema.safeParse({
        type: "room.viewer.delta",
        roomId: "room-1",
        baseViewerRevision: 3,
        viewerRevision: 4,
        viewer: roomSnapshot.viewer,
        ...serverEnvelope,
      }).success,
    ).toBe(false);
  });

  it("requires sequential shared revisions", () => {
    const sharedDelta = serverCases[3].value;
    expect(serverEventSchema.safeParse(sharedDelta).success).toBe(true);
    expect(
      serverEventSchema.safeParse({
        ...sharedDelta,
        baseRevision: 9,
        revision: 10,
      }).success,
    ).toBe(true);
    for (const revision of [8, 10]) {
      expect(
        serverEventSchema.safeParse({ ...sharedDelta, revision }).success,
      ).toBe(false);
    }
  });

  it("derives the same participant's viewer state after an atomic move", () => {
    const moveDelta = serverEventSchema.parse({
      ...serverCases[3].value,
      patch: {
        ownerParticipantId: "s1",
        player1: null,
        spectatorCount: 2,
      },
      joined: [{ participantId: "p1", displayName: "Player 1" }],
      leftParticipantIds: [],
    });
    expect(moveDelta.type).toBe("room.delta");
    if (moveDelta.type !== "room.delta") throw new Error("Expected room.delta");

    const nextState = {
      ownerParticipantId:
        moveDelta.patch.ownerParticipantId ?? roomSnapshot.ownerParticipantId,
      player1:
        moveDelta.patch.player1 === undefined
          ? roomSnapshot.player1
          : moveDelta.patch.player1,
      player2:
        moveDelta.patch.player2 === undefined
          ? roomSnapshot.player2
          : moveDelta.patch.player2,
      spectators: [
        ...roomSnapshot.spectators.filter(
          (spectator) =>
            !moveDelta.leftParticipantIds.includes(spectator.participantId),
        ),
        ...moveDelta.joined,
      ],
    };
    const viewer = deriveViewerState(
      nextState,
      roomSnapshot.viewer.participantId,
    );
    expect(viewer).toEqual({
      participantId: "p1",
      role: "spectator",
      isOwner: false,
    });
    expect(viewer.participantId).toBe(roomSnapshot.viewer.participantId);
    expect(deriveViewerState(nextState, "s1")).toEqual({
      participantId: "s1",
      role: "spectator",
      isOwner: true,
    });

    expect(
      serverEventSchema.safeParse({
        ...roomSnapshot,
        revision: moveDelta.revision,
        ownerParticipantId: nextState.ownerParticipantId,
        player1: nextState.player1,
        player2: nextState.player2,
        spectators: nextState.spectators,
        viewer,
      }).success,
    ).toBe(true);
  });

  it("refuses to derive a missing or duplicated participant", () => {
    const state = {
      ownerParticipantId: roomSnapshot.ownerParticipantId,
      player1: roomSnapshot.player1,
      player2: roomSnapshot.player2,
      spectators: roomSnapshot.spectators,
    };
    expect(() => deriveViewerState(state, "missing")).toThrow();
    expect(() =>
      deriveViewerState(
        {
          ...state,
          spectators: [
            ...state.spectators,
            { participantId: "p1", displayName: "Duplicate" },
          ],
        },
        "p1",
      ),
    ).toThrow();
  });

  it("carries full room, match, and round correlation ids", () => {
    for (const event of [
      launchSchedule,
      launchPrivate,
      serverCases[6].value,
      battleFrame,
    ]) {
      for (const field of ["roomId", "matchId", "roundId"] as const) {
        const withoutField = { ...event } as Record<string, unknown>;
        delete withoutField[field];
        expect(serverEventSchema.safeParse(withoutField).success).toBe(false);
      }
    }
  });

  it("requires revisions and ordered frame sequence numbers", () => {
    for (const snapshot of [
      lobbySnapshot,
      roomSnapshot,
      serverCases[3].value,
    ]) {
      for (const revision of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
        expect(
          serverEventSchema.safeParse({ ...snapshot, revision }).success,
        ).toBe(false);
      }
    }
    for (const sequence of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(
        serverEventSchema.safeParse({ ...battleFrame, sequence }).success,
      ).toBe(false);
    }
  });

  it("accepts 500 spectators without a product array maximum", () => {
    const snapshot = serverEventSchema.parse(maximumRoomSnapshot);
    expect(snapshot.type).toBe("room.snapshot");
    expect(
      new TextEncoder().encode(JSON.stringify(snapshot)).byteLength,
    ).toBeLessThan(200 * 1_024);
  });

  it("uses compact deltas instead of rebroadcasting the full roster", () => {
    const fullSnapshot = serverEventSchema.parse(maximumRoomSnapshot);
    const fullBytes = new TextEncoder().encode(
      JSON.stringify(fullSnapshot),
    ).byteLength;
    for (const deltaValue of [serverCases[3].value]) {
      const delta = serverEventSchema.parse(deltaValue);
      const deltaBytes = new TextEncoder().encode(
        JSON.stringify(delta),
      ).byteLength;
      expect(deltaBytes * 10).toBeLessThan(fullBytes);
    }
  });

  it("rejects invalid server times, counters, and frame numbers", () => {
    for (const serverTargetTimeMs of [
      -1,
      1.5,
      Number.MAX_SAFE_INTEGER + 1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ]) {
      expect(
        serverEventSchema.safeParse({ ...launchSchedule, serverTargetTimeMs })
          .success,
      ).toBe(false);
    }
    for (const field of ["tick", "sequence"] as const) {
      for (const value of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
        expect(
          serverEventSchema.safeParse({ ...battleFrame, [field]: value })
            .success,
        ).toBe(false);
      }
    }
    for (const angularSpeed of [Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        serverEventSchema.safeParse({
          ...battleFrame,
          player1: { ...battleFrame.player1, angularSpeed },
        }).success,
      ).toBe(false);
    }
  });

  it("enforces canonical launch multiplier bounds", () => {
    expect([LAUNCH_MULTIPLIER_MIN, LAUNCH_MULTIPLIER_MAX]).toEqual([0, 2]);
    for (const value of [LAUNCH_MULTIPLIER_MIN, LAUNCH_MULTIPLIER_MAX]) {
      expect(
        serverEventSchema.safeParse({
          ...launchPrivate,
          angularMultiplier: value,
          impulseMultiplier: value,
        }).success,
      ).toBe(true);
    }
    for (const value of [-0.001, 2.001, 1e308, Number.POSITIVE_INFINITY]) {
      expect(
        serverEventSchema.safeParse({
          ...launchPrivate,
          angularMultiplier: value,
        }).success,
      ).toBe(false);
      expect(
        serverEventSchema.safeParse({
          ...serverCases[6].value,
          player2: {
            ...serverCases[6].value.player2,
            impulseMultiplier: value,
          },
        }).success,
      ).toBe(false);
    }
  });

  it("enforces canonical battle-state bounds", () => {
    expect([
      BATTLE_POSITION_MIN_MM,
      BATTLE_POSITION_MAX_MM,
      BATTLE_ANGLE_MIN_RAD,
      BATTLE_ANGLE_MAX_RAD,
      BATTLE_ANGULAR_SPEED_MIN,
      BATTLE_ANGULAR_SPEED_MAX,
    ]).toEqual([-100, 100, -Math.PI, Math.PI, -1000, 1000]);
    expect(
      serverEventSchema.safeParse({
        ...battleFrame,
        player1: {
          x: BATTLE_POSITION_MIN_MM,
          y: BATTLE_POSITION_MAX_MM,
          angle: BATTLE_ANGLE_MIN_RAD,
          angularSpeed: BATTLE_ANGULAR_SPEED_MAX,
        },
        player2: {
          x: BATTLE_POSITION_MAX_MM,
          y: BATTLE_POSITION_MIN_MM,
          angle: BATTLE_ANGLE_MAX_RAD,
          angularSpeed: BATTLE_ANGULAR_SPEED_MIN,
        },
      }).success,
    ).toBe(true);

    const invalidBodies = [
      { ...battleFrame.player1, x: -100.001 },
      { ...battleFrame.player1, y: 100.001 },
      { ...battleFrame.player1, angle: Math.PI + 0.001 },
      { ...battleFrame.player1, angularSpeed: -1000.001 },
      { ...battleFrame.player1, x: 1e308 },
      { ...battleFrame.player1, y: Number.POSITIVE_INFINITY },
    ];
    for (const player1 of invalidBodies) {
      expect(
        serverEventSchema.safeParse({ ...battleFrame, player1 }).success,
      ).toBe(false);
    }
  });

  it("bounds public and correlation identifiers", () => {
    expect(
      serverEventSchema.safeParse({
        ...roomSnapshot,
        ownerParticipantId: "x".repeat(33),
      }).success,
    ).toBe(false);
    for (const field of ["roomId", "matchId", "roundId", "nonce"] as const) {
      expect(
        serverEventSchema.safeParse({
          ...launchSchedule,
          [field]: "x".repeat(129),
        }).success,
      ).toBe(false);
    }
  });

  it("uses player1/player2 consistently for seats and outcomes", () => {
    expect(serverEventSchema.safeParse(matchFinished).success).toBe(true);
    expect(
      serverEventSchema.safeParse({
        ...matchFinished,
        roundWinners: ["A", "B", "A"],
      }).success,
    ).toBe(false);
    expect(
      serverEventSchema.safeParse({ ...battleFrame, a: battleFrame.player1 })
        .success,
    ).toBe(false);
  });

  it("accepts only complete best-of-three match results", () => {
    const validStraightWin = {
      ...matchFinished,
      player1: { battlePoints: 2, challengePoints: 0, total: 2 },
      player2: { battlePoints: 0, challengePoints: 0.5, total: 0.5 },
      roundWinners: ["player1", "player1"],
    };
    expect(serverEventSchema.safeParse(validStraightWin).success).toBe(true);

    const invalidMatches = [
      { ...matchFinished, roundWinners: ["player1", "player2"] },
      { ...matchFinished, roundWinners: ["player1", "player1", "player2"] },
      {
        ...matchFinished,
        roundWinners: ["player1", "player2", "player2", "player1"],
      },
      { ...matchFinished, roundWinners: ["player1", "draw", "player2"] },
      {
        ...matchFinished,
        player1: { ...matchFinished.player1, battlePoints: 2, total: 2.5 },
      },
      {
        ...matchFinished,
        player1: { ...matchFinished.player1, total: 1.4 },
      },
      {
        ...matchFinished,
        player2: {
          ...matchFinished.player2,
          challengePoints: 0.25,
          total: 2.25,
        },
      },
      {
        ...matchFinished,
        player1: {
          battlePoints: 1,
          challengePoints: 0.500_001,
          total: 1.500_001,
        },
      },
    ];
    for (const match of invalidMatches) {
      expect(serverEventSchema.safeParse(match).success).toBe(false);
    }
  });

  it("allows draws only in round results, not final match winner history", () => {
    expect(serverEventSchema.safeParse(serverCases[8].value).success).toBe(
      true,
    );
    expect(
      serverEventSchema.safeParse({ ...serverCases[8].value, winner: "A" })
        .success,
    ).toBe(false);
  });

  it("exposes scores only in match.finished", () => {
    expect(
      serverEventSchema.safeParse({
        ...serverCases[8].value,
        player1: { battlePoints: 1, challengePoints: 0, total: 1 },
      }).success,
    ).toBe(false);
    expect(
      serverEventSchema.safeParse({
        ...battleFrame,
        total: { player1: 1, player2: 0 },
      }).success,
    ).toBe(false);
  });

  it("rejects unknown fields on nested objects", () => {
    expect(
      serverEventSchema.safeParse({
        ...roomSnapshot,
        player1: { ...roomSnapshot.player1, secret: "must not leak" },
      }).success,
    ).toBe(false);
  });

  it("separates private player and spectator launch-result audiences", () => {
    const platformStatus={type:"platform.status",paused:true,...serverEnvelope} as const;
    expect(playerServerEventSchema.safeParse(platformStatus).success).toBe(true);
    expect(spectatorServerEventSchema.safeParse(platformStatus).success).toBe(true);
    expect(playerServerEventSchema.safeParse(launchPrivate).success).toBe(true);
    expect(
      playerServerEventSchema.safeParse(serverCases[6].value).success,
    ).toBe(false);
    expect(
      spectatorServerEventSchema.safeParse(serverCases[6].value).success,
    ).toBe(true);
    expect(spectatorServerEventSchema.safeParse(launchPrivate).success).toBe(
      false,
    );

    const commonEvents = serverCases.filter(
      (_, index) => index !== 5 && index !== 6,
    );
    for (const { value } of commonEvents) {
      expect(playerServerEventSchema.safeParse(value).success).toBe(true);
      expect(spectatorServerEventSchema.safeParse(value).success).toBe(true);
    }
  });
});
