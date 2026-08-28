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
export const MAX_COMPENSATED_RTT_MS = 400;
export const MAX_COMPENSATED_ONE_WAY_DELAY_MS = 250;
const MAX_CLOCK_OFFSET_MS = 5 * 60_000;
const MAX_CLOCK_SAMPLES = 9;
const MAX_GENERATION_ATTEMPTS = 1_000;
const MIN_TRUSTED_CLOCK_SAMPLES = 3;
const MAX_CLOCK_ESTIMATE_AGE_MS = 30_000;
const CLOCK_NEGATIVE_DELAY_JITTER_MS = 20;
const DEFAULT_REPLAY_PROTECTION_MS = 10 * 60_000;
const MIN_REPLAY_PROTECTION_MS = 2 * 60_000;
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

export type ClockEstimate = Readonly<{
  offsetMs: number;
  medianRttMs: number;
  sampleCount: number;
  measuredAtServerMs: number;
}>;

const roundTripFromSample = (sample: ClockOffsetSample): number =>
  sample.clientReceivedAtMs -
  sample.clientSentAtMs -
  (sample.serverSentAtMs - sample.serverReceivedAtMs);

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
  const roundTripMs = roundTripFromSample(sample);
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

  estimate(): ClockEstimate | null {
    if (this.#samples.length === 0) return null;
    const roundTrips = this.#samples
      .map(roundTripFromSample)
      .sort((left, right) => left - right);
    const middle = Math.floor(roundTrips.length / 2);
    const medianRttMs =
      roundTrips.length % 2 === 1
        ? roundTrips[middle]!
        : (roundTrips[middle - 1]! + roundTrips[middle]!) / 2;
    return {
      offsetMs: this.estimatedOffsetMs,
      medianRttMs,
      sampleCount: this.#samples.length,
      measuredAtServerMs: Math.max(...this.#samples.map((sample) => sample.serverSentAtMs)),
    };
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
  getClockEstimate: (participantId: string) => ClockEstimate | null;
  leadTimeMs: number;
  acceptanceBeforeTargetMs: number;
  acceptanceAfterTargetMs: number;
  replayProtectionMs: number;
}>;

export type SubmitLaunchResult = Readonly<{
  event: LaunchResultPrivateEvent;
  replayed: boolean;
}>;

export type RoundLaunchStatus = Readonly<{
  closed: boolean;
  submittedParticipantIds: readonly string[];
}>;

type EventRecord = Readonly<{
  participantId: string;
  fingerprint: string;
  event: LaunchResultPrivateEvent;
  expiresAt: number;
}>;

type RoundState = {
  readonly schedule: LaunchScheduleEvent;
  readonly earliestAcceptedAtMs: number;
  readonly deadlineMs: number;
  readonly players: readonly [LaunchParticipant, LaunchParticipant];
  readonly results: Map<string, LaunchResultPrivateEvent>;
  readonly pendingPrivateResults: Map<string, LaunchResultPrivateEvent>;
  pendingSpectatorResult: LaunchResultSpectatorEvent | null;
  spectatorResult: LaunchResultSpectatorEvent | null;
  closed: boolean;
};

const defaultCoordinatorDependencies: LaunchCoordinatorDependencies = {
  now: () => Date.now(),
  createNonce: () => crypto.randomUUID(),
  createServerEventId: () => crypto.randomUUID(),
  getClockEstimate: () => null,
  leadTimeMs: DEFAULT_LEAD_TIME_MS,
  acceptanceBeforeTargetMs: ACCEPTANCE_BEFORE_TARGET_MS,
  acceptanceAfterTargetMs: ACCEPTANCE_AFTER_TARGET_MS,
  replayProtectionMs: DEFAULT_REPLAY_PROTECTION_MS,
};

const roundKey = (roomId: string, roundId: string): string => `${roomId}\u0000${roundId}`;

const safeTimeAdd = (left: number, right: number): number => {
  if (!isSafeNonnegativeInteger(left) || !isSafeNonnegativeInteger(right)) {
    throw new LaunchError("INVALID_SCHEDULE");
  }
  const result = left + right;
  if (!isSafeNonnegativeInteger(result)) throw new LaunchError("INVALID_SCHEDULE");
  return result;
};

const safeTimeSubtract = (left: number, right: number): number => {
  if (!isSafeNonnegativeInteger(left) || !isSafeNonnegativeInteger(right) || right > left) {
    throw new LaunchError("INVALID_SCHEDULE");
  }
  return left - right;
};

const safeCorrectedTime = (clientTimeMs: number, offsetMs: number): number | null => {
  if (!Number.isSafeInteger(offsetMs)) return null;
  const result = clientTimeMs + offsetMs;
  return isSafeNonnegativeInteger(result) ? result : null;
};

const clonePrivate = (event: LaunchResultPrivateEvent): LaunchResultPrivateEvent => ({ ...event });
const cloneSpectator = (
  event: LaunchResultSpectatorEvent | null,
): LaunchResultSpectatorEvent | null =>
  event === null ? null : { ...event, player1: { ...event.player1 }, player2: { ...event.player2 } };

export class LaunchCoordinator {
  readonly #dependencies: LaunchCoordinatorDependencies;
  readonly #rounds = new Map<string, RoundState>();
  // Time-bounded replay protection. Persistence/rotation belongs to server deployment.
  readonly #issuedNonces = new Map<string, number>();
  readonly #issuedServerEventIds = new Map<string, number>();
  readonly #activeNonces = new Set<string>();
  readonly #activeServerEventIds = new Set<string>();
  readonly #events = new Map<string, EventRecord>();
  #lastObservedServerTimeMs = 0;

  constructor(dependencies: Partial<LaunchCoordinatorDependencies> = {}) {
    this.#dependencies = { ...defaultCoordinatorDependencies, ...dependencies };
    for (const value of [
      this.#dependencies.leadTimeMs,
      this.#dependencies.acceptanceBeforeTargetMs,
      this.#dependencies.acceptanceAfterTargetMs,
      this.#dependencies.replayProtectionMs,
    ]) {
      if (!isSafeNonnegativeInteger(value)) {
        throw new LaunchError("INVALID_COORDINATOR_CONFIG");
      }
    }
    if (this.#dependencies.replayProtectionMs < MIN_REPLAY_PROTECTION_MS) {
      throw new LaunchError("INVALID_COORDINATOR_CONFIG");
    }
  }

  get activeRoundCount(): number {
    return this.#rounds.size;
  }

  get replayProtectionCounts(): Readonly<{
    issuedNonces: number;
    issuedServerEventIds: number;
    replayEvents: number;
    activeRounds: number;
    activeNonces: number;
    activeServerEventIds: number;
  }> {
    return {
      issuedNonces: this.#issuedNonces.size,
      issuedServerEventIds: this.#issuedServerEventIds.size,
      replayEvents: this.#events.size,
      activeRounds: this.#rounds.size,
      activeNonces: this.#activeNonces.size,
      activeServerEventIds: this.#activeServerEventIds.size,
    };
  }

  schedule(input: ScheduleLaunchInput): LaunchScheduleEvent {
    const now = this.#prepareServerTime(this.#dependencies.now());
    const minimumTarget = safeTimeAdd(now, this.#dependencies.leadTimeMs);
    const target = input.serverTargetTimeMs ?? minimumTarget;
    if (!isSafeNonnegativeInteger(target)) throw new LaunchError("INVALID_SCHEDULE");
    if (target < minimumTarget) {
      throw new LaunchError("TARGET_TOO_SOON");
    }
    const earliestAcceptedAtMs = safeTimeSubtract(
      target,
      this.#dependencies.acceptanceBeforeTargetMs,
    );
    const deadlineMs = safeTimeAdd(target, this.#dependencies.acceptanceAfterTargetMs);
    const expiresAt = this.#expirationFrom(now);
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

    this.#issuedNonces.set(nonce, expiresAt);
    this.#commitServerEventIds(stagedServerEventIds, expiresAt);
    this.#activeNonces.add(nonce);
    this.#addActiveServerEventIds(stagedServerEventIds);
    this.#rounds.set(key, {
      schedule: event,
      earliestAcceptedAtMs,
      deadlineMs,
      players,
      results: new Map(),
      pendingPrivateResults: new Map(),
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
    const received = this.#safeServerTime(receivedAtMs);
    const retentionNow = this.#prepareServerTime(received);
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

    if (received < state.earliestAcceptedAtMs || received > state.deadlineMs) {
      throw new LaunchError("OUTSIDE_ACCEPTANCE_WINDOW");
    }

    const correctedServerTapMs = this.#trustedCorrectedTap(
      tapEvent.clientTimeMs,
      received,
      state,
      this.#dependencies.getClockEstimate(participantId),
    );
    const gradingTimeMs = correctedServerTapMs ?? received;
    const judgement = judgeLaunch(gradingTimeMs - state.schedule.serverTargetTimeMs);
    const expiresAt = this.#expirationFrom(retentionNow);
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

    this.#commitServerEventIds(stagedServerEventIds, expiresAt);
    this.#addActiveServerEventIds(stagedServerEventIds);
    state.results.set(participantId, privateEvent);
    state.pendingPrivateResults.set(participantId, privateEvent);
    this.#events.set(tapEvent.eventId, {
      participantId,
      fingerprint,
      event: privateEvent,
      expiresAt,
    });
    if (spectatorEvent) this.#closeRound(state, spectatorEvent);
    return { event: clonePrivate(privateEvent), replayed: false };
  }

  finalizeExpired(nowMs = this.#dependencies.now()): number {
    const now = this.#safeServerTime(nowMs);
    const retentionNow = this.#prepareServerTime(now);
    const expiresAt = this.#expirationFrom(retentionNow);
    const stagedServerEventIds = new Set<string>();
    const plans: Array<{
      state: RoundState;
      generated: LaunchResultPrivateEvent[];
      spectatorEvent: LaunchResultSpectatorEvent;
    }> = [];
    for (const state of this.#rounds.values()) {
      if (state.closed) continue;
      if (now <= state.deadlineMs) continue;

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

    this.#commitServerEventIds(stagedServerEventIds, expiresAt);
    this.#addActiveServerEventIds(stagedServerEventIds);
    for (const { state, generated, spectatorEvent } of plans) {
      for (const event of generated) {
        state.results.set(event.participantId, event);
        state.pendingPrivateResults.set(event.participantId, event);
      }
      this.#closeRound(state, spectatorEvent);
    }
    return plans.length;
  }

  peekRoundStatus(roomId: string, roundId: string): RoundLaunchStatus | undefined {
    const state = this.#rounds.get(roundKey(roomId, roundId));
    return state
      ? {
          closed: state.closed,
          submittedParticipantIds: state.players.flatMap((player) =>
            state.results.has(player.participantId) ? [player.participantId] : [],
          ),
        }
      : undefined;
  }

  takePrivateResult(
    roomId: string,
    roundId: string,
    participantId: string,
  ): LaunchResultPrivateEvent | undefined {
    const state = this.#rounds.get(roundKey(roomId, roundId));
    const event = state?.pendingPrivateResults.get(participantId);
    if (!state || !event) return undefined;
    state.pendingPrivateResults.delete(participantId);
    return clonePrivate(event);
  }

  takeSpectatorResult(
    roomId: string,
    roundId: string,
  ): LaunchResultSpectatorEvent | undefined {
    const state = this.#rounds.get(roundKey(roomId, roundId));
    if (!state?.pendingSpectatorResult) return undefined;
    const event = cloneSpectator(state.pendingSpectatorResult);
    state.pendingSpectatorResult = null;
    return event ?? undefined;
  }

  cleanupRound(roomId: string, roundId: string): boolean {
    this.#prepareServerTime(this.#dependencies.now());
    const key = roundKey(roomId, roundId);
    const state = this.#rounds.get(key);
    if (!state) return false;
    if (!state.closed) throw new LaunchError("ROUND_NOT_CLOSED");
    this.#activeNonces.delete(state.schedule.nonce);
    this.#activeServerEventIds.delete(state.schedule.serverEventId);
    if (state.spectatorResult) {
      this.#activeServerEventIds.delete(state.spectatorResult.serverEventId);
    }
    for (const event of state.results.values()) {
      this.#activeServerEventIds.delete(event.serverEventId);
    }
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

  #generateNonce(): string {
    for (let attempt = 0; attempt < MAX_GENERATION_ATTEMPTS; attempt += 1) {
      const candidate = this.#dependencies.createNonce();
      if (
        correlationIdSchema.safeParse(candidate).success &&
        !this.#issuedNonces.has(candidate) &&
        !this.#activeNonces.has(candidate)
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
        !this.#activeServerEventIds.has(candidate) &&
        !stagedServerEventIds.has(candidate)
      ) {
        stagedServerEventIds.add(candidate);
        return candidate;
      }
    }
    throw new LaunchError("SERVER_EVENT_ID_GENERATION_FAILED");
  }

  #commitServerEventIds(stagedServerEventIds: ReadonlySet<string>, expiresAt: number): void {
    for (const eventId of stagedServerEventIds) {
      this.#issuedServerEventIds.set(eventId, expiresAt);
    }
  }

  #addActiveServerEventIds(stagedServerEventIds: ReadonlySet<string>): void {
    for (const eventId of stagedServerEventIds) this.#activeServerEventIds.add(eventId);
  }

  #trustedCorrectedTap(
    clientTimeMs: number,
    receivedAtMs: number,
    state: RoundState,
    estimate: ClockEstimate | null,
  ): number | null {
    if (!estimate) return null;
    if (
      !Number.isSafeInteger(estimate.offsetMs) ||
      Math.abs(estimate.offsetMs) > MAX_CLOCK_OFFSET_MS ||
      !isSafeNonnegativeInteger(estimate.sampleCount) ||
      estimate.sampleCount < MIN_TRUSTED_CLOCK_SAMPLES ||
      !Number.isFinite(estimate.medianRttMs) ||
      estimate.medianRttMs < 0 ||
      estimate.medianRttMs > MAX_COMPENSATED_RTT_MS ||
      !isSafeNonnegativeInteger(estimate.measuredAtServerMs) ||
      estimate.measuredAtServerMs > receivedAtMs ||
      receivedAtMs - estimate.measuredAtServerMs > MAX_CLOCK_ESTIMATE_AGE_MS
    ) {
      return null;
    }
    const correctedTapMs = safeCorrectedTime(clientTimeMs, estimate.offsetMs);
    if (
      correctedTapMs === null ||
      correctedTapMs < state.earliestAcceptedAtMs ||
      correctedTapMs > state.deadlineMs
    ) {
      return null;
    }
    const oneWayDelayMs = receivedAtMs - correctedTapMs;
    const maximumDelayMs = Math.min(
      estimate.medianRttMs / 2 + 50,
      MAX_COMPENSATED_ONE_WAY_DELAY_MS,
    );
    if (
      oneWayDelayMs < -CLOCK_NEGATIVE_DELAY_JITTER_MS ||
      oneWayDelayMs > maximumDelayMs
    ) {
      return null;
    }
    return correctedTapMs;
  }

  #expirationFrom(nowMs: number): number {
    return safeTimeAdd(nowMs, this.#dependencies.replayProtectionMs);
  }

  #prepareServerTime(value: number): number {
    const safeValue = this.#safeServerTime(value);
    this.#lastObservedServerTimeMs = Math.max(this.#lastObservedServerTimeMs, safeValue);
    this.#pruneAt(this.#lastObservedServerTimeMs);
    return this.#lastObservedServerTimeMs;
  }

  pruneExpiredReplayProtection(nowMs = this.#dependencies.now()): void {
    this.#prepareServerTime(nowMs);
  }

  #pruneAt(nowMs: number): void {
    for (const [nonce, expiresAt] of this.#issuedNonces) {
      if (expiresAt <= nowMs) this.#issuedNonces.delete(nonce);
    }
    for (const [eventId, expiresAt] of this.#issuedServerEventIds) {
      if (expiresAt <= nowMs) this.#issuedServerEventIds.delete(eventId);
    }
    for (const [eventId, record] of this.#events) {
      if (record.expiresAt <= nowMs) this.#events.delete(eventId);
    }
  }
}
