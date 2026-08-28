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
  type ClockEstimate,
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

const clockEstimate = (
  offsetMs: number,
  overrides: Partial<ClockEstimate> = {},
): ClockEstimate => ({
  offsetMs,
  medianRttMs: 40,
  sampleCount: 3,
  measuredAtServerMs: 3_900,
  ...overrides,
});

const makeHarness = (estimates: Readonly<Record<string, ClockEstimate | null>> = {}) => {
  let now = 1_000;
  let nonceSequence = 0;
  let eventSequence = 0;
  const coordinator = new LaunchCoordinator({
    now: () => now,
    createNonce: () => `nonce-${++nonceSequence}`,
    createServerEventId: () =>
      `00000000-0000-4000-8000-${String(++eventSequence).padStart(12, "0")}`,
    getClockEstimate: (participantId) => estimates[participantId] ?? null,
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
    expect(estimator.estimate()).toBeNull();
    estimator.addSample(ping(-100));
    for (let offset = 1; offset <= 9; offset += 1) estimator.addSample(ping(offset));
    expect(estimator.sampleCount).toBe(9);
    expect(estimator.estimatedOffsetMs).toBe(5);
    expect(estimator.estimate()).toEqual({
      offsetMs: 5,
      medianRttMs: 40,
      sampleCount: 9,
      measuredAtServerMs: 10_029,
    });
    estimator.clear();
    expect(estimator.sampleCount).toBe(0);
    expect(estimator.estimatedOffsetMs).toBe(0);
    expect(estimator.estimate()).toBeNull();
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

  it("rejects duplicate rounds and exhausts nonce generation without active state", () => {
    const { schedule } = makeHarness();
    schedule();
    expect(schedule).toThrow(new LaunchError("ROUND_ALREADY_SCHEDULED"));
    let eventSequence = 0;
    let nonceCalls = 0;
    const coordinator = new LaunchCoordinator({
      now: () => 1_000,
      createNonce: () => {
        nonceCalls += 1;
        return "same-nonce";
      },
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
    ).toThrow(new LaunchError("NONCE_GENERATION_FAILED"));
    expect(nonceCalls).toBe(1_001);
    expect(coordinator.activeRoundCount).toBe(1);
  });

  it.each([
    { players: [PLAYER_1] },
    { players: [PLAYER_1, PLAYER_2, { participantId: "p3", displayName: "Player Three" }] },
  ])("requires exactly two runtime players", ({ players }) => {
    const { coordinator } = makeHarness();
    expect(() =>
      coordinator.schedule({
        roomId: "room-1",
        matchId: "match-1",
        roundId: "round-1",
        players,
      } as never),
    ).toThrow(new LaunchError("INVALID_SCHEDULE"));
    expect(coordinator.activeRoundCount).toBe(0);
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

  it.each([
    [{ createNonce: () => "" }, "NONCE_GENERATION_FAILED"],
    [{ createServerEventId: () => "not-a-uuid" }, "SERVER_EVENT_ID_GENERATION_FAILED"],
  ] as const)("fails atomically when an injected generator is exhausted", (dependencies, code) => {
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
      ).toThrow(new LaunchError(code));
      expect(coordinator.activeRoundCount).toBe(0);
  });

  it("retries a colliding server event id and keeps all emitted ids unique", () => {
    const firstId = "00000000-0000-4000-8000-000000000001";
    const secondId = "00000000-0000-4000-8000-000000000002";
    const generatedIds = [firstId, firstId, secondId];
    const coordinator = new LaunchCoordinator({
      now: () => 1_000,
      createNonce: () => "nonce-1",
      createServerEventId: () => generatedIds.shift() ?? secondId,
    });
    const scheduled = coordinator.schedule({
      roomId: "room-1",
      matchId: "match-1",
      roundId: "round-1",
      players: [PLAYER_1, PLAYER_2],
    });
    const result = coordinator.submit("p1", tap(), 4_000);
    expect(scheduled.serverEventId).toBe(firstId);
    expect(result.event.serverEventId).toBe(secondId);
  });
});

describe("LaunchCoordinator submissions and result privacy", () => {
  it("uses corrected client time only with a fresh multi-sample plausible estimate", () => {
    const { coordinator, schedule } = makeHarness({
      p1: clockEstimate(100, { measuredAtServerMs: 3_990 }),
    });
    schedule();
    const submitted = coordinator.submit("p1", tap({ clientTimeMs: 3_900 }), 4_020);
    expect(submitted.replayed).toBe(false);
    expect(submitted.event.grade).toBe("Perfect");
  });

  it("does not award Perfect from an untrusted client timestamp", () => {
    const { coordinator, schedule } = makeHarness();
    schedule();
    expect(coordinator.submit("p1", tap({ clientTimeMs: 4_000 }), 3_000).event.grade).toBe(
      "Miss",
    );
  });

  it.each([
    [clockEstimate(0, { sampleCount: 1 }), 4_000, 4_101, "Good"],
    [clockEstimate(0, { medianRttMs: 100 }), 4_000, 3_900, "Great"],
    [clockEstimate(1_000), 3_000, 4_181, "Miss"],
    [clockEstimate(1), Number.MAX_SAFE_INTEGER, 4_181, "Miss"],
  ] as const)(
    "falls back to receivedAt for low-quality or implausible clock evidence %#",
    (estimate, clientTimeMs, receivedAtMs, grade) => {
      const { coordinator, schedule } = makeHarness({ p1: estimate });
      schedule();
      expect(
        coordinator.submit("p1", tap({ clientTimeMs }), receivedAtMs).event.grade,
      ).toBe(grade);
    },
  );

  it("falls back when the clock estimate is older than thirty seconds", () => {
    const coordinator = new LaunchCoordinator({
      now: () => 1_000,
      createNonce: () => "nonce-1",
      createServerEventId: (() => {
        let sequence = 0;
        return () =>
          `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`;
      })(),
      getClockEstimate: () =>
        clockEstimate(0, { measuredAtServerMs: 0, medianRttMs: 100 }),
    });
    coordinator.schedule({
      roomId: "room-1",
      matchId: "match-1",
      roundId: "round-1",
      players: [PLAYER_1, PLAYER_2],
      serverTargetTimeMs: 40_000,
    });
    expect(
      coordinator.submit("p1", tap({ clientTimeMs: 40_000 }), 40_101).event.grade,
    ).toBe("Good");
  });

  it("trusts an exact zero offset backed by three plausible samples", () => {
    const { coordinator, schedule } = makeHarness({
      p1: clockEstimate(0, { medianRttMs: 100 }),
    });
    schedule();
    expect(coordinator.submit("p1", tap(), 4_101).event.grade).toBe("Perfect");
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

  it.each([2_999, 5_501])("rejects authoritative received time outside the anti-cheat window", (receivedAtMs) => {
    const { coordinator, schedule } = makeHarness();
    schedule();
    expect(() => coordinator.submit("p1", tap(), receivedAtMs)).toThrow(
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
    expect(coordinator.peekRoundStatus("room-1", "round-1")).toEqual({
      closed: false,
      submittedParticipantIds: ["p1"],
    });
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

  it("does not partially commit when result event-id generation is exhausted", () => {
    const scheduleId = "00000000-0000-4000-8000-000000000001";
    const player1Id = "00000000-0000-4000-8000-000000000002";
    const player2Id = "00000000-0000-4000-8000-000000000003";
    const spectatorId = "00000000-0000-4000-8000-000000000004";
    let generatedIds = [scheduleId, player1Id];
    let fallbackId = player1Id;
    const coordinator = new LaunchCoordinator({
      now: () => 1_000,
      createNonce: () => "nonce-1",
      createServerEventId: () => generatedIds.shift() ?? fallbackId,
    });
    coordinator.schedule({
      roomId: "room-1",
      matchId: "match-1",
      roundId: "round-1",
      players: [PLAYER_1, PLAYER_2],
    });
    coordinator.submit("p1", tap(), 4_000);

    expect(() => coordinator.submit("p2", tap({ eventId: TAP_2 }), 4_000)).toThrow(
      new LaunchError("SERVER_EVENT_ID_GENERATION_FAILED"),
    );
    expect(coordinator.peekRoundStatus("room-1", "round-1")).toEqual({
      closed: false,
      submittedParticipantIds: ["p1"],
    });

    generatedIds = [player2Id, spectatorId];
    fallbackId = spectatorId;
    expect(coordinator.submit("p2", tap({ eventId: TAP_2 }), 4_000).event.serverEventId).toBe(
      player2Id,
    );
    expect(coordinator.takeSpectatorResult("room-1", "round-1")?.serverEventId).toBe(
      spectatorId,
    );
  });

  it("emits exact private and spectator protocol payloads without opponent leakage", () => {
    const { coordinator, schedule } = makeHarness();
    schedule();
    const private1 = coordinator.submit("p1", tap(), 4_000).event;
    expect(coordinator.takeSpectatorResult("room-1", "round-1")).toBeUndefined();
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

    const spectator = coordinator.takeSpectatorResult("room-1", "round-1");
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
  it("keeps the round open at the inclusive deadline and auto-Misses only after it", () => {
    const { coordinator, schedule, setNow } = makeHarness();
    schedule();
    setNow(5_499);
    expect(coordinator.finalizeExpired()).toBe(0);
    setNow(5_500);
    expect(coordinator.finalizeExpired()).toBe(0);
    setNow(5_501);
    const finalized = coordinator.finalizeExpired();
    expect(finalized).toBe(1);
    expect(coordinator.takePrivateResult("room-1", "round-1", "p1")?.grade).toBe("Miss");
    expect(coordinator.takePrivateResult("room-1", "round-1", "p2")?.grade).toBe("Miss");
    const spectator = coordinator.takeSpectatorResult("room-1", "round-1");
    expect(spectator?.player1.grade).toBe("Miss");
    expect(spectator?.player2.grade).toBe("Miss");
  });

  it("auto-Misses only the missing participant", () => {
    const { coordinator, schedule, setNow } = makeHarness();
    schedule();
    coordinator.submit("p1", tap(), 4_000);
    setNow(5_501);
    coordinator.finalizeExpired();
    expect(coordinator.takePrivateResult("room-1", "round-1", "p1")?.grade).toBe("Perfect");
    expect(coordinator.takePrivateResult("room-1", "round-1", "p2")?.grade).toBe("Miss");
  });

  it("drains private results per participant and spectator results separately", () => {
    const { coordinator, schedule, setNow } = makeHarness();
    schedule();
    setNow(5_501);
    coordinator.finalizeExpired();
    expect(coordinator.peekRoundStatus("room-1", "round-1")).toEqual({
      closed: true,
      submittedParticipantIds: ["p1", "p2"],
    });
    const player1 = coordinator.takePrivateResult("room-1", "round-1", "p1");
    expect(player1).toMatchObject({ participantId: "p1", grade: "Miss" });
    expect(JSON.stringify(player1)).not.toContain("p2");
    expect(JSON.stringify(player1)).not.toContain("Player Two");
    expect(coordinator.takePrivateResult("room-1", "round-1", "p1")).toBeUndefined();
    expect(coordinator.takePrivateResult("room-1", "round-1", "unknown")).toBeUndefined();
    expect(coordinator.takePrivateResult("room-1", "round-1", "p2")).toMatchObject({
      participantId: "p2",
    });
    expect(coordinator.takeSpectatorResult("room-1", "round-1")).toBeDefined();
    expect(coordinator.takeSpectatorResult("room-1", "round-1")).toBeUndefined();
    expect(coordinator.cleanupRound("room-1", "round-1")).toBe(true);
    expect(coordinator.activeRoundCount).toBe(0);
    expect(coordinator.peekRoundStatus("room-1", "round-1")).toBeUndefined();
    expect(coordinator.cleanupRound("room-1", "round-1")).toBe(false);
  });

  it("refuses cleanup of an open round", () => {
    const { coordinator, schedule } = makeHarness();
    schedule();
    expect(() => coordinator.cleanupRound("room-1", "round-1")).toThrow(
      new LaunchError("ROUND_NOT_CLOSED"),
    );
  });

  it("produces the same outcome whether finalize or tap is called first at the deadline", () => {
    const first = makeHarness();
    first.schedule();
    first.setNow(5_500);
    expect(first.coordinator.finalizeExpired()).toBe(0);
    first.coordinator.submit("p1", tap({ clientTimeMs: 5_500 }), 5_500);
    first.setNow(5_501);
    first.coordinator.finalizeExpired();

    const second = makeHarness();
    second.schedule();
    second.setNow(5_500);
    second.coordinator.submit("p1", tap({ clientTimeMs: 5_500 }), 5_500);
    expect(second.coordinator.finalizeExpired()).toBe(0);
    second.setNow(5_501);
    second.coordinator.finalizeExpired();

    expect(first.coordinator.peekRoundStatus("room-1", "round-1")).toEqual(
      second.coordinator.peekRoundStatus("room-1", "round-1"),
    );
    expect(first.coordinator.takePrivateResult("room-1", "round-1", "p1")).toEqual(
      second.coordinator.takePrivateResult("room-1", "round-1", "p1"),
    );
    expect(first.coordinator.takePrivateResult("room-1", "round-1", "p2")).toEqual(
      second.coordinator.takePrivateResult("room-1", "round-1", "p2"),
    );
  });

  it("rejects nonce reuse during TTL, then permits reuse after expiry", () => {
    const serverIds = Array.from(
      { length: 4 },
      (_, index) => `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    );
    let now = 1_000;
    const coordinator = new LaunchCoordinator({
      now: () => now,
      createNonce: () => "ttl-nonce",
      createServerEventId: () => serverIds.shift() ?? "00000000-0000-4000-8000-000000000004",
    });
    const input = {
      roomId: "room-1",
      matchId: "match-1",
      roundId: "round-1",
      players: [PLAYER_1, PLAYER_2],
    } as const;
    coordinator.schedule(input);
    coordinator.finalizeExpired(5_501);
    coordinator.cleanupRound("room-1", "round-1");

    expect(() => coordinator.schedule(input)).toThrow(
      new LaunchError("NONCE_GENERATION_FAILED"),
    );
    expect(coordinator.activeRoundCount).toBe(0);
    expect(() =>
      coordinator.submit(
        "p1",
        tap({ nonce: "ttl-nonce" }),
        4_000,
      ),
    ).toThrow(new LaunchError("SCHEDULE_MISMATCH"));
    now = 605_502;
    expect(coordinator.schedule(input).nonce).toBe("ttl-nonce");
  });

  it("rejects server event id reuse during TTL, then permits reuse after expiry", () => {
    const firstId = "00000000-0000-4000-8000-000000000001";
    const generatedIds = Array.from(
      { length: 4 },
      (_, index) => `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    );
    let nonceSequence = 0;
    let now = 1_000;
    const coordinator = new LaunchCoordinator({
      now: () => now,
      createNonce: () => `nonce-${++nonceSequence}`,
      createServerEventId: () => generatedIds.shift() ?? firstId,
    });
    const input = {
      roomId: "room-1",
      matchId: "match-1",
      roundId: "round-1",
      players: [PLAYER_1, PLAYER_2],
    } as const;
    coordinator.schedule(input);
    coordinator.finalizeExpired(5_501);
    coordinator.cleanupRound("room-1", "round-1");
    expect(() => coordinator.schedule(input)).toThrow(
      new LaunchError("SERVER_EVENT_ID_GENERATION_FAILED"),
    );
    expect(coordinator.activeRoundCount).toBe(0);
    now = 605_502;
    expect(coordinator.schedule(input).serverEventId).toBe(firstId);
  });
});

describe("LaunchCoordinator bounded replay protection and safe arithmetic", () => {
  it("requires at least two minutes of replay protection", () => {
    expect(() => new LaunchCoordinator({ replayProtectionMs: 119_999 })).toThrow(
      new LaunchError("INVALID_COORDINATOR_CONFIG"),
    );
  });

  it.each([
    {
      now: Number.MAX_SAFE_INTEGER - 1_000,
      input: {},
    },
    {
      now: 0,
      input: { serverTargetTimeMs: Number.MAX_SAFE_INTEGER - 1_000 },
    },
    {
      now: 0,
      dependencies: { leadTimeMs: 0 },
      input: { serverTargetTimeMs: 500 },
    },
  ])("rejects unsafe derived schedule times %#", ({ now, dependencies = {}, input }) => {
    const coordinator = new LaunchCoordinator({
      now: () => now,
      createNonce: () => "nonce-1",
      createServerEventId: () => "00000000-0000-4000-8000-000000000001",
      ...dependencies,
    });
    expect(() =>
      coordinator.schedule({
        roomId: "room-1",
        matchId: "match-1",
        roundId: "round-1",
        players: [PLAYER_1, PLAYER_2],
        ...input,
      }),
    ).toThrow(new LaunchError("INVALID_SCHEDULE"));
    expect(coordinator.activeRoundCount).toBe(0);
  });

  it("keeps replay records through cleanup, then expires all tombstones", () => {
    let now = 1_000;
    let nonceSequence = 0;
    let eventSequence = 0;
    const coordinator = new LaunchCoordinator({
      now: () => now,
      createNonce: () => `nonce-${++nonceSequence}`,
      createServerEventId: () =>
        `00000000-0000-4000-8000-${String(++eventSequence).padStart(12, "0")}`,
      replayProtectionMs: 120_000,
    });
    const input = {
      roomId: "room-1",
      matchId: "match-1",
      roundId: "round-1",
      players: [PLAYER_1, PLAYER_2],
    } as const;
    coordinator.schedule(input);
    const first = coordinator.submit("p1", tap(), 4_000);
    now = 5_501;
    coordinator.finalizeExpired();
    coordinator.cleanupRound("room-1", "round-1");
    expect(coordinator.replayProtectionCounts).toEqual({
      issuedNonces: 1,
      issuedServerEventIds: 4,
      replayEvents: 1,
      activeRounds: 0,
    });
    expect(coordinator.submit("p1", tap(), 4_000)).toEqual({ ...first, replayed: true });

    now = 125_502;
    expect(() => coordinator.submit("p1", tap(), now)).toThrow(
      new LaunchError("SCHEDULE_MISMATCH"),
    );
    expect(coordinator.replayProtectionCounts).toEqual({
      issuedNonces: 0,
      issuedServerEventIds: 0,
      replayEvents: 0,
      activeRounds: 0,
    });
  });

  it("bounds replay tombstones across ten thousand cleaned rounds", () => {
    let now = 1_000;
    let nonceSequence = 0;
    let eventSequence = 0;
    const coordinator = new LaunchCoordinator({
      now: () => now,
      createNonce: () => `nonce-${++nonceSequence}`,
      createServerEventId: () => {
        eventSequence += 1;
        const tail = String(eventSequence % 1_000_000_000_000).padStart(12, "0");
        return `00000000-0000-4000-8000-${tail}`;
      },
      replayProtectionMs: 120_000,
    });
    for (let index = 0; index < 10_000; index += 1) {
      const roomId = `room-${index}`;
      const roundId = `round-${index}`;
      coordinator.schedule({
        roomId,
        matchId: `match-${index}`,
        roundId,
        players: [PLAYER_1, PLAYER_2],
      });
      now += 4_501;
      coordinator.finalizeExpired();
      coordinator.cleanupRound(roomId, roundId);
      now += 1;
    }
    expect(coordinator.replayProtectionCounts.activeRounds).toBe(0);
    expect(coordinator.replayProtectionCounts.issuedNonces).toBeLessThan(30);
    expect(coordinator.replayProtectionCounts.issuedServerEventIds).toBeLessThan(120);

    now += 120_001;
    coordinator.pruneExpiredReplayProtection(now);
    expect(coordinator.replayProtectionCounts).toEqual({
      issuedNonces: 0,
      issuedServerEventIds: 0,
      replayEvents: 0,
      activeRounds: 0,
    });
  });

  it("does not expire tombstones when the server clock moves backwards", () => {
    let now = 500_000;
    const coordinator = new LaunchCoordinator({
      now: () => now,
      createNonce: () => "nonce-1",
      createServerEventId: () => "00000000-0000-4000-8000-000000000001",
    });
    coordinator.schedule({
      roomId: "room-1",
      matchId: "match-1",
      roundId: "round-1",
      players: [PLAYER_1, PLAYER_2],
    });
    now = 400_000;
    coordinator.pruneExpiredReplayProtection(now);
    expect(coordinator.replayProtectionCounts.issuedNonces).toBe(1);
    expect(coordinator.replayProtectionCounts.issuedServerEventIds).toBe(1);
  });

  it("does not reuse an id still referenced by an active round after TTL", () => {
    const fixedId = "00000000-0000-4000-8000-000000000001";
    let now = 1_000;
    let nonceSequence = 0;
    const coordinator = new LaunchCoordinator({
      now: () => now,
      createNonce: () => `nonce-${++nonceSequence}`,
      createServerEventId: () => fixedId,
      replayProtectionMs: 120_000,
    });
    coordinator.schedule({
      roomId: "room-1",
      matchId: "match-1",
      roundId: "round-1",
      players: [PLAYER_1, PLAYER_2],
    });
    now = 121_001;
    expect(() =>
      coordinator.schedule({
        roomId: "room-2",
        matchId: "match-2",
        roundId: "round-2",
        players: [PLAYER_1, PLAYER_2],
      }),
    ).toThrow(new LaunchError("SERVER_EVENT_ID_GENERATION_FAILED"));
  });
});
