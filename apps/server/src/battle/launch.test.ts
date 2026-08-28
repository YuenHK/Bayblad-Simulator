import { describe, expect, it } from "vitest";
import {
  launchScheduleEventSchema,
  playerServerEventSchema,
  spectatorServerEventSchema,
} from "@steam-top/protocol";
import {
  ClockOffsetEstimator,
  LAUNCH_MULTIPLIER,
  LAUNCH_WINDOWS_MS,
  LaunchCoordinator,
  LaunchError,
  estimateClockOffset,
  judgeLaunch,
  type ClockOffsetSample,
} from "./launch";

const PLAYER_1 = { participantId: "p1", displayName: "Player One" };
const PLAYER_2 = { participantId: "p2", displayName: "Player Two" };
const TAP_1 = "10000000-0000-4000-8000-000000000001";
const TAP_2 = "10000000-0000-4000-8000-000000000002";

const ping = (
  offsetMs: number,
  networkOutMs = 20,
  networkBackMs = 20,
  processingMs = 0,
): ClockOffsetSample => {
  const clientSentAtMs = 10_000;
  const serverReceivedAtMs = clientSentAtMs + networkOutMs + offsetMs;
  const serverSentAtMs = serverReceivedAtMs + processingMs;
  const clientReceivedAtMs = serverSentAtMs - offsetMs + networkBackMs;
  return { clientSentAtMs, serverReceivedAtMs, serverSentAtMs, clientReceivedAtMs };
};

const makeHarness = (offsets: Readonly<Record<string, number>> = {}) => {
  let now = 1_000;
  let nonceSequence = 0;
  let eventSequence = 0;
  const coordinator = new LaunchCoordinator({
    now: () => now,
    createNonce: () => `nonce-${++nonceSequence}`,
    createServerEventId: () =>
      `00000000-0000-4000-8000-${String(++eventSequence).padStart(12, "0")}`,
    getEstimatedOffsetMs: (participantId) => offsets[participantId] ?? 0,
  });
  return {
    coordinator,
    setNow: (value: number) => {
      now = value;
    },
    schedule: () =>
      coordinator.schedule({
        roomId: "room-1",
        matchId: "match-1",
        roundId: "round-1",
        players: [PLAYER_1, PLAYER_2],
      }),
  };
};

const tap = (overrides: Record<string, unknown> = {}) => ({
  type: "launch.tap",
  protocolVersion: 1,
  eventId: TAP_1,
  roomId: "room-1",
  roundId: "round-1",
  nonce: "nonce-1",
  clientTimeMs: 4_000,
  ...overrides,
});

describe("judgeLaunch", () => {
  it("exports the exact official windows and separately configurable multipliers", () => {
    expect(LAUNCH_WINDOWS_MS).toEqual({ perfect: 45, great: 100, good: 180 });
    expect(LAUNCH_MULTIPLIER).toEqual({
      Perfect: { angular: 1.1, impulse: 1.1 },
      Great: { angular: 1, impulse: 1 },
      Good: { angular: 0.9, impulse: 0.9 },
      Miss: { angular: 0.75, impulse: 0.75 },
    });
  });

  it.each([
    [0, "Perfect", 1.1],
    [45, "Perfect", 1.1],
    [-45, "Perfect", 1.1],
    [46, "Great", 1],
    [-100, "Great", 1],
    [100, "Great", 1],
    [101, "Good", 0.9],
    [-180, "Good", 0.9],
    [180, "Good", 0.9],
    [181, "Miss", 0.75],
    [-181, "Miss", 0.75],
  ] as const)("maps a signed %sms delta to %s", (deltaMs, grade, multiplier) => {
    expect(judgeLaunch(deltaMs)).toEqual({
      grade,
      angularMultiplier: multiplier,
      impulseMultiplier: multiplier,
    });
  });

  it("supports different angular and impulse multipliers", () => {
    expect(
      judgeLaunch(0, {
        windowsMs: { perfect: 1, great: 2, good: 3 },
        multipliers: {
          Perfect: { angular: 1.2, impulse: 1.1 },
          Great: { angular: 1, impulse: 0.95 },
          Good: { angular: 0.8, impulse: 0.7 },
          Miss: { angular: 0.5, impulse: 0.4 },
        },
      }),
    ).toEqual({ grade: "Perfect", angularMultiplier: 1.2, impulseMultiplier: 1.1 });
  });

  it.each([
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  ])("rejects non-finite delta %s", (deltaMs) => {
    expect(() => judgeLaunch(deltaMs)).toThrow(new LaunchError("INVALID_LAUNCH_CONFIG"));
  });

  it.each([
    { windowsMs: { perfect: -1, great: 100, good: 180 } },
    { windowsMs: { perfect: 101, great: 100, good: 180 } },
    { windowsMs: { perfect: 45.5, great: 100, good: 180 } },
    { windowsMs: { perfect: 45, great: 100, good: Number.MAX_SAFE_INTEGER + 1 } },
    { multipliers: { Perfect: { angular: -0.1, impulse: 1.1 } } },
    { multipliers: { Miss: { angular: 0.75, impulse: 2.01 } } },
    { multipliers: { Good: { angular: Number.NaN, impulse: 0.9 } } },
  ])("rejects invalid config %#", (config) => {
    expect(() => judgeLaunch(0, config as never)).toThrow(
      new LaunchError("INVALID_LAUNCH_CONFIG"),
    );
  });
});

describe("clock offset estimation", () => {
  it("defines NTP-style timestamps and returns the median server-minus-client offset", () => {
    expect(estimateClockOffset([ping(90), ping(100), ping(110)])).toBe(100);
    expect(estimateClockOffset([])).toBe(0);
  });

  it("uses a robust median in the presence of an allowed outlier", () => {
    expect(estimateClockOffset([ping(100), ping(101), ping(299_000)])).toBe(101);
  });

  it.each([
    { ...ping(0), clientReceivedAtMs: 9_999 },
    { ...ping(0), serverSentAtMs: ping(0).serverReceivedAtMs - 1 },
    {
      clientSentAtMs: 10_000,
      serverReceivedAtMs: 10_000,
      serverSentAtMs: 10_020,
      clientReceivedAtMs: 10_010,
    },
    { ...ping(0), clientSentAtMs: Number.NaN },
    { ...ping(0), clientSentAtMs: Number.MAX_SAFE_INTEGER + 1 },
    ping(0, 1_001, 1_001),
    ping(300_001),
  ])("rejects invalid, high-RTT, or unreasonable samples %#", (sample) => {
    expect(() => estimateClockOffset([sample])).toThrow(
      new LaunchError("INVALID_CLOCK_SAMPLE"),
    );
  });

  it("retains only the latest nine valid samples", () => {
    const estimator = new ClockOffsetEstimator();
    estimator.addSample(ping(-100));
    for (let offset = 1; offset <= 9; offset += 1) estimator.addSample(ping(offset));
    expect(estimator.sampleCount).toBe(9);
    expect(estimator.estimatedOffsetMs).toBe(5);
    estimator.clear();
    expect(estimator.sampleCount).toBe(0);
    expect(estimator.estimatedOffsetMs).toBe(0);
  });
});

describe("LaunchCoordinator scheduling", () => {
  it("creates a protocol-valid schedule at the default three-second lead", () => {
    const { schedule } = makeHarness();
    const event = schedule();
    expect(launchScheduleEventSchema.parse(event)).toEqual(event);
    expect(event).toEqual({
      type: "launch.schedule",
      protocolVersion: 1,
      serverEventId: "00000000-0000-4000-8000-000000000001",
      roomId: "room-1",
      matchId: "match-1",
      roundId: "round-1",
      serverTargetTimeMs: 4_000,
      nonce: "nonce-1",
    });
  });

  it("rejects duplicate rounds and duplicate active nonces", () => {
    const { schedule } = makeHarness();
    schedule();
    expect(schedule).toThrow(new LaunchError("ROUND_ALREADY_SCHEDULED"));
    let eventSequence = 0;
    const coordinator = new LaunchCoordinator({
      now: () => 1_000,
      createNonce: () => "same-nonce",
      createServerEventId: () =>
        `00000000-0000-4000-8000-${String(++eventSequence).padStart(12, "0")}`,
    });
    coordinator.schedule({
      roomId: "room-1",
      matchId: "match-1",
      roundId: "round-1",
      players: [PLAYER_1, PLAYER_2],
    });
    expect(() =>
      coordinator.schedule({
        roomId: "room-2",
        matchId: "match-2",
        roundId: "round-2",
        players: [PLAYER_1, PLAYER_2],
      }),
    ).toThrow(new LaunchError("NONCE_ALREADY_ACTIVE"));
  });

  it.each([Number.NaN, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects unsafe server target %s",
    (serverTargetTimeMs) => {
      const { coordinator } = makeHarness();
      expect(() =>
        coordinator.schedule({
          roomId: "room-1",
          matchId: "match-1",
          roundId: "round-1",
          players: [PLAYER_1, PLAYER_2],
          serverTargetTimeMs,
        }),
      ).toThrow();
    },
  );

  it("rejects targets before the configured lead time", () => {
    const { coordinator } = makeHarness();
    expect(() =>
      coordinator.schedule({
        roomId: "room-1",
        matchId: "match-1",
        roundId: "round-1",
        players: [PLAYER_1, PLAYER_2],
        serverTargetTimeMs: 3_999,
      }),
    ).toThrow(new LaunchError("TARGET_TOO_SOON"));
  });

  it("fails atomically when an injected nonce or event id is invalid", () => {
    for (const dependencies of [
      { createNonce: () => "" },
      { createServerEventId: () => "not-a-uuid" },
    ]) {
      const coordinator = new LaunchCoordinator({
        now: () => 1_000,
        createNonce: () => "nonce-ok",
        createServerEventId: () => "00000000-0000-4000-8000-000000000001",
        ...dependencies,
      });
      expect(() =>
        coordinator.schedule({
          roomId: "room-1",
          matchId: "match-1",
          roundId: "round-1",
          players: [PLAYER_1, PLAYER_2],
        }),
      ).toThrow(new LaunchError("INVALID_GENERATED_VALUE"));
      expect(coordinator.activeRoundCount).toBe(0);
    }
  });
});

describe("LaunchCoordinator submissions and result privacy", () => {
  it("corrects client time with the server-owned offset estimator", () => {
    const { coordinator, schedule } = makeHarness({ p1: 100 });
    schedule();
    const submitted = coordinator.submit("p1", tap({ clientTimeMs: 3_900 }), 4_000);
    expect(submitted.replayed).toBe(false);
    expect(submitted.event.grade).toBe("Perfect");
  });

  it.each([
    [{ roomId: "wrong-room" }, "SCHEDULE_MISMATCH"],
    [{ roundId: "wrong-round" }, "SCHEDULE_MISMATCH"],
    [{ nonce: "wrong-nonce" }, "SCHEDULE_MISMATCH"],
  ] as const)("rejects a mismatched tap %#", (override, code) => {
    const { coordinator, schedule } = makeHarness();
    schedule();
    expect(() => coordinator.submit("p1", tap(override), 4_000)).toThrow(
      new LaunchError(code),
    );
  });

  it("parses launch.tap before processing and rejects unknown participants", () => {
    const { coordinator, schedule } = makeHarness();
    schedule();
    expect(() => coordinator.submit("p1", { ...tap(), extra: true }, 4_000)).toThrow(
      new LaunchError("INVALID_TAP"),
    );
    expect(() => coordinator.submit("outsider", tap(), 4_000)).toThrow(
      new LaunchError("UNKNOWN_PARTICIPANT"),
    );
  });

  it.each([
    [2_999, 4_000],
    [5_501, 4_000],
    [4_000, 2_999],
    [4_000, 5_501],
  ])("rejects received/corrected time outside the anti-cheat window", (receivedAtMs, clientTimeMs) => {
    const { coordinator, schedule } = makeHarness();
    schedule();
    expect(() => coordinator.submit("p1", tap({ clientTimeMs }), receivedAtMs)).toThrow(
      new LaunchError("OUTSIDE_ACCEPTANCE_WINDOW"),
    );
  });

  it.each([3_000, 5_500])(
    "accepts the inclusive server and corrected-time boundary at %sms",
    (boundaryMs) => {
      const { coordinator, schedule } = makeHarness();
      schedule();
      expect(
        coordinator.submit("p1", tap({ clientTimeMs: boundaryMs }), boundaryMs).event.grade,
      ).toBe("Miss");
    },
  );

  it("does not accept a client-supplied clock offset", () => {
    const { coordinator, schedule } = makeHarness();
    schedule();
    expect(() => coordinator.submit("p1", { ...tap(), estimatedOffsetMs: 50 }, 4_000)).toThrow(
      new LaunchError("INVALID_TAP"),
    );
  });

  it("accepts a 181ms Miss and lets both players consume the same schedule nonce", () => {
    const { coordinator, schedule } = makeHarness();
    schedule();
    expect(coordinator.submit("p1", tap({ clientTimeMs: 4_181 }), 4_181).event.grade).toBe(
      "Miss",
    );
    expect(
      coordinator.submit(
        "p2",
        tap({ eventId: TAP_2, clientTimeMs: 4_000 }),
        4_000,
      ).event.grade,
    ).toBe("Perfect");
  });

  it("replays an identical participant event without consuming twice", () => {
    const { coordinator, schedule } = makeHarness();
    schedule();
    const first = coordinator.submit("p1", tap(), 4_000);
    const replay = coordinator.submit("p1", tap(), 4_000);
    expect(first.replayed).toBe(false);
    expect(replay).toEqual({ ...first, replayed: true });
    expect(coordinator.peekResults("room-1", "round-1")?.privateResults).toHaveLength(1);
  });

  it("rejects one event id reused across payloads or participants", () => {
    const { coordinator, schedule } = makeHarness();
    schedule();
    coordinator.submit("p1", tap(), 4_000);
    expect(() => coordinator.submit("p1", tap({ clientTimeMs: 4_001 }), 4_001)).toThrow(
      new LaunchError("EVENT_ID_CONFLICT"),
    );
    expect(() => coordinator.submit("p2", tap(), 4_000)).toThrow(
      new LaunchError("EVENT_ID_CONFLICT"),
    );
  });

  it("rejects a second distinct tap and any tap after a closed round", () => {
    const { coordinator, schedule } = makeHarness();
    schedule();
    coordinator.submit("p1", tap(), 4_000);
    expect(() => coordinator.submit("p1", tap({ eventId: TAP_2 }), 4_000)).toThrow(
      new LaunchError("ALREADY_SUBMITTED"),
    );
    coordinator.submit("p2", tap({ eventId: TAP_2 }), 4_000);
    expect(() =>
      coordinator.submit(
        "p1",
        tap({ eventId: "10000000-0000-4000-8000-000000000003" }),
        4_000,
      ),
    ).toThrow(new LaunchError("ROUND_CLOSED"));
  });

  it("emits exact private and spectator protocol payloads without opponent leakage", () => {
    const { coordinator, schedule } = makeHarness();
    schedule();
    const private1 = coordinator.submit("p1", tap(), 4_000).event;
    expect(coordinator.peekResults("room-1", "round-1")?.spectatorResult).toBeNull();
    const private2 = coordinator.submit("p2", tap({ eventId: TAP_2, clientTimeMs: 4_101 }), 4_101).event;
    expect(playerServerEventSchema.parse(private1)).toEqual(private1);
    expect(playerServerEventSchema.parse(private2)).toEqual(private2);
    expect(private1).toEqual({
      type: "launch.result.private",
      protocolVersion: 1,
      serverEventId: "00000000-0000-4000-8000-000000000002",
      roomId: "room-1",
      matchId: "match-1",
      roundId: "round-1",
      participantId: "p1",
      grade: "Perfect",
      angularMultiplier: 1.1,
      impulseMultiplier: 1.1,
    });
    expect(JSON.stringify(private1)).not.toContain("Player");
    expect(JSON.stringify(private1)).not.toContain("p2");

    const spectator = coordinator.peekResults("room-1", "round-1")?.spectatorResult;
    expect(spectatorServerEventSchema.parse(spectator)).toEqual(spectator);
    expect(playerServerEventSchema.safeParse(spectator).success).toBe(false);
    expect(spectator).toEqual({
      type: "launch.result.spectator",
      protocolVersion: 1,
      serverEventId: "00000000-0000-4000-8000-000000000004",
      roomId: "room-1",
      matchId: "match-1",
      roundId: "round-1",
      player1: {
        participantId: "p1",
        displayName: "Player One",
        grade: "Perfect",
        angularMultiplier: 1.1,
        impulseMultiplier: 1.1,
      },
      player2: {
        participantId: "p2",
        displayName: "Player Two",
        grade: "Good",
        angularMultiplier: 0.9,
        impulseMultiplier: 0.9,
      },
    });
  });
});

describe("LaunchCoordinator expiry and cleanup", () => {
  it("does not finalize before the deadline and auto-Misses missing taps at the deadline", () => {
    const { coordinator, schedule, setNow } = makeHarness();
    schedule();
    setNow(5_499);
    expect(coordinator.finalizeExpired()).toEqual([]);
    setNow(5_500);
    const finalized = coordinator.finalizeExpired();
    expect(finalized).toHaveLength(1);
    expect(finalized[0]?.privateResults.map((event) => event.grade)).toEqual(["Miss", "Miss"]);
    expect(finalized[0]?.spectatorResult?.player1.grade).toBe("Miss");
    expect(finalized[0]?.spectatorResult?.player2.grade).toBe("Miss");
  });

  it("auto-Misses only the missing participant", () => {
    const { coordinator, schedule, setNow } = makeHarness();
    schedule();
    coordinator.submit("p1", tap(), 4_000);
    setNow(5_500);
    coordinator.finalizeExpired();
    const result = coordinator.peekResults("room-1", "round-1");
    expect(result?.privateResults.map((event) => [event.participantId, event.grade])).toEqual([
      ["p1", "Perfect"],
      ["p2", "Miss"],
    ]);
  });

  it("supports peek and draining take, then explicit closed-round cleanup", () => {
    const { coordinator, schedule, setNow } = makeHarness();
    schedule();
    setNow(5_500);
    coordinator.finalizeExpired();
    expect(coordinator.peekResults("room-1", "round-1")?.privateResults).toHaveLength(2);
    expect(coordinator.takeResults("room-1", "round-1")?.privateResults).toHaveLength(2);
    expect(coordinator.takeResults("room-1", "round-1")).toEqual({
      privateResults: [],
      spectatorResult: null,
      closed: true,
    });
    expect(coordinator.cleanupRound("room-1", "round-1")).toBe(true);
    expect(coordinator.activeRoundCount).toBe(0);
    expect(coordinator.peekResults("room-1", "round-1")).toBeUndefined();
    expect(coordinator.cleanupRound("room-1", "round-1")).toBe(false);
  });

  it("refuses cleanup of an open round", () => {
    const { coordinator, schedule } = makeHarness();
    schedule();
    expect(() => coordinator.cleanupRound("room-1", "round-1")).toThrow(
      new LaunchError("ROUND_NOT_CLOSED"),
    );
  });
});
