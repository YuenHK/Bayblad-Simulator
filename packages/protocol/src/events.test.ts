import { describe, expect, it } from "vitest";
import { clientEventSchema, serverEventSchema } from "./events";

const eventId = "550e8400-e29b-41d4-a716-446655440000";
const designId = "7d9e2c75-2ef5-4ea7-aac2-18f385c1f82a";

const clientCases = [
  {
    type: "room.create",
    valid: { type: "room.create", name: "  測試房  ", eventId },
    invalid: { type: "room.create", name: " ", eventId },
  },
  {
    type: "room.join",
    valid: { type: "room.join", roomId: "A102", role: "spectator", eventId },
    invalid: { type: "room.join", roomId: "A102", role: "owner", eventId },
  },
  {
    type: "room.move",
    valid: { type: "room.move", roomId: "A102", target: "player1", eventId },
    invalid: { type: "room.move", roomId: "A102", target: "player3", eventId },
  },
  {
    type: "player.ready",
    valid: { type: "player.ready", roomId: "A102", designId, eventId },
    invalid: { type: "player.ready", roomId: "A102", designId: "not-a-uuid", eventId },
  },
  {
    type: "launch.tap",
    valid: {
      type: "launch.tap",
      roomId: "A102",
      roundId: "round-1",
      nonce: "nonce-1",
      clientTimeMs: 1_000.5,
      eventId,
    },
    invalid: {
      type: "launch.tap",
      roomId: "A102",
      roundId: "round-1",
      nonce: "nonce-1",
      clientTimeMs: Number.POSITIVE_INFINITY,
      eventId,
    },
  },
  {
    type: "room.close",
    valid: { type: "room.close", roomId: "A102", eventId },
    invalid: { type: "room.close", roomId: "", eventId },
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
    expect(() =>
      clientEventSchema.parse({ type: "player.ready", roomId: "A102", eventId }),
    ).toThrow();
  });

  it("accepts a spectator join", () => {
    const parsed = clientEventSchema.parse({
      type: "room.join",
      roomId: "A102",
      role: "spectator",
      eventId,
    });
    expect(parsed.type).toBe("room.join");
    if (parsed.type === "room.join") expect(parsed.role).toBe("spectator");
  });

  it("trims room names", () => {
    expect(
      clientEventSchema.parse({ type: "room.create", name: "  測試房  ", eventId }),
    ).toMatchObject({ name: "測試房" });
  });

  it("requires a UUID event id and rejects unknown fields", () => {
    expect(
      clientEventSchema.safeParse({
        type: "room.close",
        roomId: "A102",
        eventId: "event-1",
      }).success,
    ).toBe(false);
    expect(
      clientEventSchema.safeParse({
        type: "room.close",
        roomId: "A102",
        eventId,
        unexpected: true,
      }).success,
    ).toBe(false);
  });

  it("bounds identifiers and rejects non-finite client times", () => {
    expect(
      clientEventSchema.safeParse({
        type: "room.join",
        roomId: "x".repeat(129),
        role: "player",
        eventId,
      }).success,
    ).toBe(false);
    for (const clientTimeMs of [Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        clientEventSchema.safeParse({
          type: "launch.tap",
          roomId: "A102",
          roundId: "round-1",
          nonce: "nonce-1",
          clientTimeMs,
          eventId,
        }).success,
      ).toBe(false);
    }
  });
});

const seat = {
  userId: "user-a",
  displayName: "Player A",
  ready: true,
  designId,
};

const launchPlayer = {
  userId: "user-a",
  displayName: "Player A",
  grade: "Perfect",
  angularMultiplier: 1.1,
  impulseMultiplier: 1.1,
};

const serverCases = [
  {
    type: "lobby.snapshot",
    value: {
      type: "lobby.snapshot",
      rooms: [
        {
          id: "room-1",
          code: "A102",
          name: "測試房",
          phase: "waiting",
          player1: { displayName: "Player A" },
          player2: { displayName: null },
          spectatorCount: 3,
        },
      ],
    },
  },
  {
    type: "room.snapshot",
    value: {
      type: "room.snapshot",
      id: "room-1",
      code: "A102",
      name: "測試房",
      ownerId: "user-a",
      phase: "launch",
      player1: seat,
      player2: { userId: null, displayName: null, ready: null, designId: null },
      spectators: [{ userId: "user-s", displayName: "Spectator" }],
      viewerRole: "player1",
      viewerUserId: "user-a",
    },
  },
  {
    type: "launch.schedule",
    value: {
      type: "launch.schedule",
      roomId: "room-1",
      roundId: "round-1",
      serverTargetTimeMs: 1_000,
      nonce: "nonce-1",
    },
  },
  {
    type: "launch.result.private",
    value: {
      type: "launch.result.private",
      userId: "user-a",
      grade: "Great",
      angularMultiplier: 1,
      impulseMultiplier: 1,
    },
  },
  {
    type: "launch.result.spectator",
    value: {
      type: "launch.result.spectator",
      A: launchPlayer,
      B: { ...launchPlayer, userId: "user-b", displayName: "Player B", grade: "Good" },
    },
  },
  {
    type: "battle.frame",
    value: {
      type: "battle.frame",
      roomId: "room-1",
      matchId: "match-1",
      tick: 12,
      a: { x: 1, y: 2, angle: 0.5, angularSpeed: 10 },
      b: { x: 3, y: 4, angle: 0.75, angularSpeed: 9 },
    },
  },
  {
    type: "round.finished",
    value: { type: "round.finished", winner: "A" },
  },
  {
    type: "match.finished",
    value: {
      type: "match.finished",
      A: { battlePoints: 2, challengePoints: 0, total: 2 },
      B: { battlePoints: 1, challengePoints: 0.5, total: 1.5 },
      roundWinners: ["A", "B", "A"],
    },
  },
  {
    type: "error",
    value: { type: "error", code: "ROOM_CLOSED", message: "Room closed", eventId },
  },
] as const;

describe("serverEventSchema", () => {
  it.each(serverCases)("accepts a valid $type event", ({ value }) => {
    expect(serverEventSchema.safeParse(value).success).toBe(true);
  });

  it("prevents opponent launch data leaking in private results", () => {
    const privateResult = serverCases[3].value;
    expect(
      serverEventSchema.safeParse({ ...privateResult, opponentGrade: "Miss" }).success,
    ).toBe(false);
    expect(
      serverEventSchema.safeParse({ ...privateResult, opponent: launchPlayer }).success,
    ).toBe(false);
  });

  it("keeps spectator names out of lobby snapshots", () => {
    const lobby = serverCases[0].value;
    expect(
      serverEventSchema.safeParse({
        ...lobby,
        rooms: [{ ...lobby.rooms[0], spectators: [{ displayName: "Hidden" }] }],
      }).success,
    ).toBe(false);
  });

  it("exposes scores only in match.finished", () => {
    expect(
      serverEventSchema.safeParse({
        type: "round.finished",
        winner: "A",
        A: { battlePoints: 1, challengePoints: 0, total: 1 },
      }).success,
    ).toBe(false);
    expect(
      serverEventSchema.safeParse({
        ...serverCases[5].value,
        total: { A: 1, B: 0 },
      }).success,
    ).toBe(false);
  });

  it("accepts 500 spectators in a room snapshot", () => {
    const room = serverCases[1].value;
    const spectators = Array.from({ length: 500 }, (_, index) => ({
      userId: `spectator-${index}`,
      displayName: `Spectator ${index}`,
    }));
    expect(serverEventSchema.safeParse({ ...room, spectators }).success).toBe(true);
  });

  it("rejects invalid server times, ticks, and frame numbers", () => {
    const schedule = serverCases[2].value;
    for (const serverTargetTimeMs of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        serverEventSchema.safeParse({ ...schedule, serverTargetTimeMs }).success,
      ).toBe(false);
    }

    const frame = serverCases[5].value;
    for (const tick of [-1, 1.5, Number.NaN]) {
      expect(serverEventSchema.safeParse({ ...frame, tick }).success).toBe(false);
    }
    for (const angularSpeed of [Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        serverEventSchema.safeParse({
          ...frame,
          a: { ...frame.a, angularSpeed },
        }).success,
      ).toBe(false);
    }
  });

  it("rejects unknown fields on nested objects", () => {
    const room = serverCases[1].value;
    expect(
      serverEventSchema.safeParse({
        ...room,
        player1: { ...room.player1, secret: "must not leak" },
      }).success,
    ).toBe(false);
  });
});
