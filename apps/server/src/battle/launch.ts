import {
  PROTOCOL_VERSION,
  correlationIdSchema,
  eventIdSchema,
  launchResultPrivateEventSchema,
  launchResultSpectatorEventSchema,
  launchScheduleEventSchema,
  launchTapEventSchema,
  participantSummarySchema,
  type LaunchGrade,
  type LaunchResultPrivateEvent,
  type LaunchResultSpectatorEvent,
  type LaunchScheduleEvent,
} from "@steam-top/protocol";

export const LAUNCH_WINDOWS_MS = Object.freeze({
  perfect: 45,
  great: 100,
  good: 180,
});

export const LAUNCH_MULTIPLIER = Object.freeze({
  Perfect: Object.freeze({ angular: 1.1, impulse: 1.1 }),
  Great: Object.freeze({ angular: 1, impulse: 1 }),
  Good: Object.freeze({ angular: 0.9, impulse: 0.9 }),
  Miss: Object.freeze({ angular: 0.75, impulse: 0.75 }),
});

const DEFAULT_LEAD_TIME_MS = 3_000;
const ACCEPTANCE_BEFORE_TARGET_MS = 1_000;
const ACCEPTANCE_AFTER_TARGET_MS = 1_500;
const MAX_CLOCK_RTT_MS = 2_000;
const MAX_CLOCK_OFFSET_MS = 5 * 60_000;
const MAX_CLOCK_SAMPLES = 9;
const MAX_GENERATION_ATTEMPTS = 1_000;
const GRADES = ["Perfect", "Great", "Good", "Miss"] as const;

export type LaunchErrorCode =
  | "INVALID_LAUNCH_CONFIG"
  | "INVALID_CLOCK_SAMPLE"
  | "INVALID_COORDINATOR_CONFIG"
  | "INVALID_SCHEDULE"
  | "INVALID_GENERATED_VALUE"
  | "NONCE_GENERATION_FAILED"
  | "SERVER_EVENT_ID_GENERATION_FAILED"
  | "TARGET_TOO_SOON"
  | "ROUND_ALREADY_SCHEDULED"
  | "INVALID_TAP"
  | "SCHEDULE_MISMATCH"
  | "UNKNOWN_PARTICIPANT"
  | "OUTSIDE_ACCEPTANCE_WINDOW"
  | "EVENT_ID_CONFLICT"
  | "ALREADY_SUBMITTED"
  | "ROUND_CLOSED"
  | "ROUND_NOT_CLOSED";

export class LaunchError extends Error {
  readonly code: LaunchErrorCode;

  constructor(code: LaunchErrorCode) {
    super(code);
    this.name = "LaunchError";
    this.code = code;
  }
}

type Multipliers = Readonly<{ angular: number; impulse: number }>;
type Windows = Readonly<{ perfect: number; great: number; good: number }>;

export type LaunchJudgementConfig = Readonly<{
  windowsMs?: Partial<Windows>;
  multipliers?: Partial<Record<LaunchGrade, Partial<Multipliers>>>;
}>;

export type LaunchJudgement = Readonly<{
  grade: LaunchGrade;
  angularMultiplier: number;
  impulseMultiplier: number;
}>;

const isSafeNonnegativeInteger = (value: number): boolean =>
  Number.isSafeInteger(value) && value >= 0;

const validateMultiplier = (value: number): void => {
  if (!Number.isFinite(value) || value < 0 || value > 2) {
    throw new LaunchError("INVALID_LAUNCH_CONFIG");
  }
};

const resolveJudgementConfig = (
  config: LaunchJudgementConfig = {},
): Readonly<{ windowsMs: Windows; multipliers: Readonly<Record<LaunchGrade, Multipliers>> }> => {
  const windowsMs = { ...LAUNCH_WINDOWS_MS, ...config.windowsMs };
  if (
    !isSafeNonnegativeInteger(windowsMs.perfect) ||
    !isSafeNonnegativeInteger(windowsMs.great) ||
    !isSafeNonnegativeInteger(windowsMs.good) ||
    windowsMs.perfect > windowsMs.great ||
    windowsMs.great > windowsMs.good
  ) {
    throw new LaunchError("INVALID_LAUNCH_CONFIG");
  }

  const multipliers = Object.fromEntries(
    GRADES.map((grade) => {
      const value = { ...LAUNCH_MULTIPLIER[grade], ...config.multipliers?.[grade] };
      validateMultiplier(value.angular);
      validateMultiplier(value.impulse);
      return [grade, value];
    }),
  ) as Record<LaunchGrade, Multipliers>;
  return { windowsMs, multipliers };
};

export const judgeLaunch = (
  deltaMs: number,
  config: LaunchJudgementConfig = {},
): LaunchJudgement => {
  if (!Number.isFinite(deltaMs)) throw new LaunchError("INVALID_LAUNCH_CONFIG");
  const { windowsMs, multipliers } = resolveJudgementConfig(config);
  const absoluteDeltaMs = Math.abs(deltaMs);
  const grade: LaunchGrade =
    absoluteDeltaMs <= windowsMs.perfect
      ? "Perfect"
      : absoluteDeltaMs <= windowsMs.great
        ? "Great"
        : absoluteDeltaMs <= windowsMs.good
          ? "Good"
          : "Miss";
  const multiplier = multipliers[grade];
  return {
    grade,
    angularMultiplier: multiplier.angular,
    impulseMultiplier: multiplier.impulse,
  };
};

/**
 * Four timestamps for an NTP-style ping sample. Client and server clocks may differ.
 * RTT is (clientReceived-clientSent) minus server processing time. Offset is the
 * midpoint estimate of server time minus client time.
 */
export type ClockOffsetSample = Readonly<{
  clientSentAtMs: number;
  serverReceivedAtMs: number;
  serverSentAtMs: number;
  clientReceivedAtMs: number;
}>;

const offsetFromSample = (sample: ClockOffsetSample): number => {
  const timestamps = [
    sample.clientSentAtMs,
    sample.serverReceivedAtMs,
    sample.serverSentAtMs,
    sample.clientReceivedAtMs,
  ];
  if (!timestamps.every(isSafeNonnegativeInteger)) {
    throw new LaunchError("INVALID_CLOCK_SAMPLE");
  }
  if (
    sample.clientReceivedAtMs < sample.clientSentAtMs ||
    sample.serverSentAtMs < sample.serverReceivedAtMs
  ) {
    throw new LaunchError("INVALID_CLOCK_SAMPLE");
  }
  const roundTripMs =
    sample.clientReceivedAtMs -
    sample.clientSentAtMs -
    (sample.serverSentAtMs - sample.serverReceivedAtMs);
  const offsetMs =
    (sample.serverReceivedAtMs -
      sample.clientSentAtMs +
      (sample.serverSentAtMs - sample.clientReceivedAtMs)) /
    2;
  if (
    roundTripMs < 0 ||
    roundTripMs > MAX_CLOCK_RTT_MS ||
    !Number.isFinite(offsetMs) ||
    Math.abs(offsetMs) > MAX_CLOCK_OFFSET_MS
  ) {
    throw new LaunchError("INVALID_CLOCK_SAMPLE");
  }
  return offsetMs;
};

export const estimateClockOffset = (samples: readonly ClockOffsetSample[]): number => {
  if (samples.length === 0) return 0;
  const offsets = samples.map(offsetFromSample).sort((left, right) => left - right);
  const middle = Math.floor(offsets.length / 2);
  if (offsets.length % 2 === 1) return offsets[middle]!;
  return (offsets[middle - 1]! + offsets[middle]!) / 2;
};

export class ClockOffsetEstimator {
  #samples: ClockOffsetSample[] = [];

  get sampleCount(): number {
    return this.#samples.length;
  }

  get estimatedOffsetMs(): number {
    return estimateClockOffset(this.#samples);
  }

  addSample(sample: ClockOffsetSample): number {
    offsetFromSample(sample);
    this.#samples.push({ ...sample });
    if (this.#samples.length > MAX_CLOCK_SAMPLES) this.#samples.shift();
    return this.estimatedOffsetMs;
  }

  clear(): void {
    this.#samples = [];
  }
}

export type LaunchParticipant = Readonly<{
  participantId: string;
  displayName: string;
}>;

export type ScheduleLaunchInput = Readonly<{
  roomId: string;
  matchId: string;
  roundId: string;
  players: readonly [LaunchParticipant, LaunchParticipant];
  serverTargetTimeMs?: number;
}>;

export type LaunchCoordinatorDependencies = Readonly<{
  now: () => number;
  createNonce: () => string;
  createServerEventId: () => string;
  getEstimatedOffsetMs: (participantId: string) => number;
  leadTimeMs: number;
  acceptanceBeforeTargetMs: number;
  acceptanceAfterTargetMs: number;
}>;

export type SubmitLaunchResult = Readonly<{
  event: LaunchResultPrivateEvent;
  replayed: boolean;
}>;

export type RoundLaunchResults = Readonly<{
  privateResults: readonly LaunchResultPrivateEvent[];
  spectatorResult: LaunchResultSpectatorEvent | null;
  closed: boolean;
}>;

type EventRecord = Readonly<{
  participantId: string;
  fingerprint: string;
  event: LaunchResultPrivateEvent;
  roundKey: string;
}>;

type RoundState = {
  readonly schedule: LaunchScheduleEvent;
  readonly players: readonly [LaunchParticipant, LaunchParticipant];
  readonly results: Map<string, LaunchResultPrivateEvent>;
  readonly clientEventIds: Set<string>;
  pendingPrivateResults: LaunchResultPrivateEvent[];
  pendingSpectatorResult: LaunchResultSpectatorEvent | null;
  spectatorResult: LaunchResultSpectatorEvent | null;
  closed: boolean;
};

const defaultCoordinatorDependencies: LaunchCoordinatorDependencies = {
  now: () => Date.now(),
  createNonce: () => crypto.randomUUID(),
  createServerEventId: () => crypto.randomUUID(),
  getEstimatedOffsetMs: () => 0,
  leadTimeMs: DEFAULT_LEAD_TIME_MS,
  acceptanceBeforeTargetMs: ACCEPTANCE_BEFORE_TARGET_MS,
  acceptanceAfterTargetMs: ACCEPTANCE_AFTER_TARGET_MS,
};

const roundKey = (roomId: string, roundId: string): string => `${roomId}\u0000${roundId}`;

const clonePrivate = (event: LaunchResultPrivateEvent): LaunchResultPrivateEvent => ({ ...event });
const cloneSpectator = (
  event: LaunchResultSpectatorEvent | null,
): LaunchResultSpectatorEvent | null =>
  event === null ? null : { ...event, player1: { ...event.player1 }, player2: { ...event.player2 } };

export class LaunchCoordinator {
  readonly #dependencies: LaunchCoordinatorDependencies;
  readonly #rounds = new Map<string, RoundState>();
  // Process-lifetime replay protection. Persistence/rotation belongs to server deployment.
  readonly #issuedNonces = new Set<string>();
  readonly #issuedServerEventIds = new Set<string>();
  readonly #events = new Map<string, EventRecord>();

  constructor(dependencies: Partial<LaunchCoordinatorDependencies> = {}) {
    this.#dependencies = { ...defaultCoordinatorDependencies, ...dependencies };
    for (const value of [
      this.#dependencies.leadTimeMs,
      this.#dependencies.acceptanceBeforeTargetMs,
      this.#dependencies.acceptanceAfterTargetMs,
    ]) {
      if (!isSafeNonnegativeInteger(value)) {
        throw new LaunchError("INVALID_COORDINATOR_CONFIG");
      }
    }
  }

  get activeRoundCount(): number {
    return this.#rounds.size;
  }

  schedule(input: ScheduleLaunchInput): LaunchScheduleEvent {
    const now = this.#safeServerTime(this.#dependencies.now());
    const target = input.serverTargetTimeMs ?? now + this.#dependencies.leadTimeMs;
    if (!isSafeNonnegativeInteger(target)) throw new LaunchError("INVALID_SCHEDULE");
    if (target < now + this.#dependencies.leadTimeMs) {
      throw new LaunchError("TARGET_TOO_SOON");
    }
    const key = roundKey(input.roomId, input.roundId);
    if (this.#rounds.has(key)) throw new LaunchError("ROUND_ALREADY_SCHEDULED");

    let players: [LaunchParticipant, LaunchParticipant];
    try {
      if (!Array.isArray(input.players) || input.players.length !== 2) {
        throw new LaunchError("INVALID_SCHEDULE");
      }
      correlationIdSchema.parse(input.roomId);
      correlationIdSchema.parse(input.matchId);
      correlationIdSchema.parse(input.roundId);
      players = [
        participantSummarySchema.parse(input.players[0]),
        participantSummarySchema.parse(input.players[1]),
      ];
    } catch {
      throw new LaunchError("INVALID_SCHEDULE");
    }
    if (players[0].participantId === players[1].participantId) {
      throw new LaunchError("INVALID_SCHEDULE");
    }

    const nonce = this.#generateNonce();
    const stagedServerEventIds = new Set<string>();
    let event: LaunchScheduleEvent;
    try {
      event = launchScheduleEventSchema.parse({
        type: "launch.schedule",
        protocolVersion: PROTOCOL_VERSION,
        serverEventId: this.#stageServerEventId(stagedServerEventIds),
        roomId: input.roomId,
        matchId: input.matchId,
        roundId: input.roundId,
        serverTargetTimeMs: target,
        nonce,
      });
    } catch (error) {
      if (error instanceof LaunchError) throw error;
      throw new LaunchError("INVALID_GENERATED_VALUE");
    }

    this.#issuedNonces.add(nonce);
    this.#commitServerEventIds(stagedServerEventIds);
    this.#rounds.set(key, {
      schedule: event,
      players,
      results: new Map(),
      clientEventIds: new Set(),
      pendingPrivateResults: [],
      pendingSpectatorResult: null,
      spectatorResult: null,
      closed: false,
    });
    return { ...event };
  }

  submit(participantId: string, rawEvent: unknown, receivedAtMs = this.#dependencies.now()): SubmitLaunchResult {
    let tapEvent: ReturnType<typeof launchTapEventSchema.parse>;
    try {
      tapEvent = launchTapEventSchema.parse(rawEvent);
    } catch {
      throw new LaunchError("INVALID_TAP");
    }
    const fingerprint = JSON.stringify(tapEvent);
    const previous = this.#events.get(tapEvent.eventId);
    if (previous) {
      if (previous.participantId !== participantId || previous.fingerprint !== fingerprint) {
        throw new LaunchError("EVENT_ID_CONFLICT");
      }
      return { event: clonePrivate(previous.event), replayed: true };
    }

    const key = roundKey(tapEvent.roomId, tapEvent.roundId);
    const state = this.#rounds.get(key);
    if (!state || state.schedule.nonce !== tapEvent.nonce) {
      throw new LaunchError("SCHEDULE_MISMATCH");
    }
    const player = state.players.find((candidate) => candidate.participantId === participantId);
    if (!player) throw new LaunchError("UNKNOWN_PARTICIPANT");
    if (state.closed) throw new LaunchError("ROUND_CLOSED");
    if (state.results.has(participantId)) throw new LaunchError("ALREADY_SUBMITTED");

    const received = this.#safeServerTime(receivedAtMs);
    const estimatedOffsetMs = this.#dependencies.getEstimatedOffsetMs(participantId);
    if (!Number.isFinite(estimatedOffsetMs) || Math.abs(estimatedOffsetMs) > MAX_CLOCK_OFFSET_MS) {
      throw new LaunchError("INVALID_CLOCK_SAMPLE");
    }
    const correctedServerTapMs = tapEvent.clientTimeMs + estimatedOffsetMs;
    const earliest = state.schedule.serverTargetTimeMs - this.#dependencies.acceptanceBeforeTargetMs;
    const latest = state.schedule.serverTargetTimeMs + this.#dependencies.acceptanceAfterTargetMs;
    if (
      !Number.isFinite(correctedServerTapMs) ||
      received < earliest ||
      received > latest ||
      correctedServerTapMs < earliest ||
      correctedServerTapMs > latest
    ) {
      throw new LaunchError("OUTSIDE_ACCEPTANCE_WINDOW");
    }

    const judgement = judgeLaunch(correctedServerTapMs - state.schedule.serverTargetTimeMs);
    const stagedServerEventIds = new Set<string>();
    const privateEvent = this.#createPrivateEvent(
      state,
      participantId,
      judgement,
      stagedServerEventIds,
    );
    const proposedResults = new Map(state.results).set(participantId, privateEvent);
    const spectatorEvent =
      proposedResults.size === state.players.length
        ? this.#createSpectatorEvent(state, proposedResults, stagedServerEventIds)
        : null;

    this.#commitServerEventIds(stagedServerEventIds);
    state.results.set(participantId, privateEvent);
    state.pendingPrivateResults.push(privateEvent);
    state.clientEventIds.add(tapEvent.eventId);
    this.#events.set(tapEvent.eventId, {
      participantId,
      fingerprint,
      event: privateEvent,
      roundKey: key,
    });
    if (spectatorEvent) this.#closeRound(state, spectatorEvent);
    return { event: clonePrivate(privateEvent), replayed: false };
  }

  finalizeExpired(nowMs = this.#dependencies.now()): RoundLaunchResults[] {
    const now = this.#safeServerTime(nowMs);
    const stagedServerEventIds = new Set<string>();
    const plans: Array<{
      state: RoundState;
      generated: LaunchResultPrivateEvent[];
      spectatorEvent: LaunchResultSpectatorEvent;
    }> = [];
    for (const state of this.#rounds.values()) {
      if (state.closed) continue;
      const deadline =
        state.schedule.serverTargetTimeMs + this.#dependencies.acceptanceAfterTargetMs;
      if (now <= deadline) continue;

      const generated = state.players
        .filter((player) => !state.results.has(player.participantId))
        .map((player) =>
          this.#createPrivateEvent(
            state,
            player.participantId,
            {
              grade: "Miss",
              angularMultiplier: LAUNCH_MULTIPLIER.Miss.angular,
              impulseMultiplier: LAUNCH_MULTIPLIER.Miss.impulse,
            },
            stagedServerEventIds,
          ),
        );
      const proposedResults = new Map(state.results);
      for (const event of generated) proposedResults.set(event.participantId, event);
      const spectatorEvent = this.#createSpectatorEvent(
        state,
        proposedResults,
        stagedServerEventIds,
      );
      plans.push({ state, generated, spectatorEvent });
    }

    this.#commitServerEventIds(stagedServerEventIds);
    const finalized: RoundLaunchResults[] = [];
    for (const { state, generated, spectatorEvent } of plans) {
      for (const event of generated) {
        state.results.set(event.participantId, event);
        state.pendingPrivateResults.push(event);
      }
      this.#closeRound(state, spectatorEvent);
      finalized.push(this.#snapshot(state));
    }
    return finalized;
  }

  peekResults(roomId: string, roundId: string): RoundLaunchResults | undefined {
    const state = this.#rounds.get(roundKey(roomId, roundId));
    return state ? this.#snapshot(state) : undefined;
  }

  takeResults(roomId: string, roundId: string): RoundLaunchResults | undefined {
    const state = this.#rounds.get(roundKey(roomId, roundId));
    if (!state) return undefined;
    const result = {
      privateResults: state.pendingPrivateResults.map(clonePrivate),
      spectatorResult: cloneSpectator(state.pendingSpectatorResult),
      closed: state.closed,
    };
    state.pendingPrivateResults = [];
    state.pendingSpectatorResult = null;
    return result;
  }

  cleanupRound(roomId: string, roundId: string): boolean {
    const key = roundKey(roomId, roundId);
    const state = this.#rounds.get(key);
    if (!state) return false;
    if (!state.closed) throw new LaunchError("ROUND_NOT_CLOSED");
    for (const eventId of state.clientEventIds) this.#events.delete(eventId);
    this.#rounds.delete(key);
    return true;
  }

  #safeServerTime(value: number): number {
    if (!isSafeNonnegativeInteger(value)) throw new LaunchError("INVALID_SCHEDULE");
    return value;
  }

  #createPrivateEvent(
    state: RoundState,
    participantId: string,
    judgement: LaunchJudgement,
    stagedServerEventIds: Set<string>,
  ): LaunchResultPrivateEvent {
    try {
      return launchResultPrivateEventSchema.parse({
        type: "launch.result.private",
        protocolVersion: PROTOCOL_VERSION,
        serverEventId: this.#stageServerEventId(stagedServerEventIds),
        roomId: state.schedule.roomId,
        matchId: state.schedule.matchId,
        roundId: state.schedule.roundId,
        participantId,
        ...judgement,
      });
    } catch (error) {
      if (error instanceof LaunchError) throw error;
      throw new LaunchError("INVALID_GENERATED_VALUE");
    }
  }

  #createSpectatorEvent(
    state: RoundState,
    results: ReadonlyMap<string, LaunchResultPrivateEvent>,
    stagedServerEventIds: Set<string>,
  ): LaunchResultSpectatorEvent {
    const [player1, player2] = state.players;
    const result1 = results.get(player1.participantId);
    const result2 = results.get(player2.participantId);
    if (!result1 || !result2) throw new LaunchError("INVALID_SCHEDULE");
    try {
      return launchResultSpectatorEventSchema.parse({
        type: "launch.result.spectator",
        protocolVersion: PROTOCOL_VERSION,
        serverEventId: this.#stageServerEventId(stagedServerEventIds),
        roomId: state.schedule.roomId,
        matchId: state.schedule.matchId,
        roundId: state.schedule.roundId,
        player1: { ...player1, ...this.#judgementFromEvent(result1) },
        player2: { ...player2, ...this.#judgementFromEvent(result2) },
      });
    } catch (error) {
      if (error instanceof LaunchError) throw error;
      throw new LaunchError("INVALID_GENERATED_VALUE");
    }
  }

  #judgementFromEvent(event: LaunchResultPrivateEvent): LaunchJudgement {
    return {
      grade: event.grade,
      angularMultiplier: event.angularMultiplier,
      impulseMultiplier: event.impulseMultiplier,
    };
  }

  #closeRound(state: RoundState, spectatorEvent: LaunchResultSpectatorEvent): void {
    state.spectatorResult = spectatorEvent;
    state.pendingSpectatorResult = spectatorEvent;
    state.closed = true;
  }

  #snapshot(state: RoundState): RoundLaunchResults {
    return {
      privateResults: state.players.flatMap((player) => {
        const result = state.results.get(player.participantId);
        return result ? [clonePrivate(result)] : [];
      }),
      spectatorResult: cloneSpectator(state.spectatorResult),
      closed: state.closed,
    };
  }

  #generateNonce(): string {
    for (let attempt = 0; attempt < MAX_GENERATION_ATTEMPTS; attempt += 1) {
      const candidate = this.#dependencies.createNonce();
      if (
        correlationIdSchema.safeParse(candidate).success &&
        !this.#issuedNonces.has(candidate)
      ) {
        return candidate;
      }
    }
    throw new LaunchError("NONCE_GENERATION_FAILED");
  }

  #stageServerEventId(stagedServerEventIds: Set<string>): string {
    for (let attempt = 0; attempt < MAX_GENERATION_ATTEMPTS; attempt += 1) {
      const candidate = this.#dependencies.createServerEventId();
      if (
        eventIdSchema.safeParse(candidate).success &&
        !this.#issuedServerEventIds.has(candidate) &&
        !stagedServerEventIds.has(candidate)
      ) {
        stagedServerEventIds.add(candidate);
        return candidate;
      }
    }
    throw new LaunchError("SERVER_EVENT_ID_GENERATION_FAILED");
  }

  #commitServerEventIds(stagedServerEventIds: ReadonlySet<string>): void {
    for (const eventId of stagedServerEventIds) this.#issuedServerEventIds.add(eventId);
  }
}
