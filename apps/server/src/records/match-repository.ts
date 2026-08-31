import { and, asc, eq, inArray, lt, lte, ne, or, sql } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";
import type { DatabaseClient } from "@steam-top/db";
import { buildCompletedMatchRow, buildRoundRow } from "@steam-top/db/persistence";
import { identities, matchParticipantSnapshots, matchPersistenceJobs, matches, rounds } from "@steam-top/db/schema";
import { z } from "zod";
import { battleResultSchema } from "./battle-result-repository";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const diagnosticSchema = z.object({
  identityId: z.uuid().nullable(),
  identitySource: z.enum(["iclass", "cookie", "guest"]),
  deviceName: z.string().max(128).nullable(),
  ip: z.string().max(64).nullable(),
  userAgent: z.string().max(512).nullable(),
}).strict();
const scoreSchema = z.object({ battlePoints: z.number().int().min(0).max(2), challengePoints: z.number().min(0).max(.5), total: z.number().min(0).max(2.5) }).strict();
const roundSchema = z.object({
  id: z.uuid(), externalRoundId: z.string().regex(/^[A-Za-z0-9_-]+$/).max(128),
  roundNumber: z.number().int().min(1).max(3), attempt: z.number().int().positive().max(1_000),
  inputFingerprint: hash,
  launchA: z.object({ grade: z.enum(["Perfect", "Great", "Good", "Miss"]), angularMultiplier: z.number().min(0).max(2), impulseMultiplier: z.number().min(0).max(2), tapReceivedAtMs: z.number().finite().nullable(), tapOffsetMs: z.number().finite().nullable() }).strict(),
  launchB: z.object({ grade: z.enum(["Perfect", "Great", "Good", "Miss"]), angularMultiplier: z.number().min(0).max(2), impulseMultiplier: z.number().min(0).max(2), tapReceivedAtMs: z.number().finite().nullable(), tapOffsetMs: z.number().finite().nullable() }).strict(),
  startedAt: z.date(), completedAt: z.date(),
  battleResult: battleResultSchema,
}).strict();

export const completedMatchRecordSchema = z.object({
  id: z.uuid(), roomId: z.uuid().nullable(), idempotencyFingerprint: hash,
  player1: diagnosticSchema.extend({ designId: z.uuid(), massG: z.number().positive().max(60), score: scoreSchema }),
  player2: diagnosticSchema.extend({ designId: z.uuid(), massG: z.number().positive().max(60), score: scoreSchema }),
  roundWinners: z.array(z.enum(["player1", "player2"])).min(2).max(3),
  rounds: z.array(roundSchema).min(2).max(1_000),
  performanceModelVersion: z.string().trim().min(1).max(64),
  physicsModelVersion: z.string().trim().min(1).max(64),
  protocolVersion: z.number().int().positive(), spectatorCount: z.number().int().nonnegative(),
  startedAt: z.date(), completedAt: z.date(),
}).strict().superRefine((value, context) => {
  const nonDraw = value.rounds.filter((round) => round.battleResult.outcome.winner !== "draw").map((round) => round.battleResult.outcome.winner);
  if (JSON.stringify(nonDraw) !== JSON.stringify(value.roundWinners)) context.addIssue({ code: "custom", message: "roundWinners must exactly equal non-draw outcomes" });
  if (value.rounds.some((round) => round.battleResult.modelVersion !== value.physicsModelVersion)) context.addIssue({ code: "custom", message: "physics model versions differ" });
  if (value.completedAt < value.startedAt || value.rounds.some((round) => round.completedAt < round.startedAt)) context.addIssue({ code: "custom", message: "invalid time order" });
  const wins1 = value.roundWinners.filter((winner) => winner === "player1").length;
  const wins2 = value.roundWinners.length - wins1;
  if ((wins1 !== 2 && wins2 !== 2) || value.player1.score.battlePoints !== wins1 || value.player2.score.battlePoints !== wins2) context.addIssue({ code: "custom", message: "scores must match completed best-of-three winners" });
  for (const player of [value.player1, value.player2]) if (Math.abs(player.score.total - player.score.battlePoints - player.score.challengePoints) > 1e-9) context.addIssue({ code: "custom", message: "score total mismatch" });
  const expectedChallenge1 = value.player1.massG < value.player2.massG ? Math.min((value.player2.massG - value.player1.massG) * .05, .5) : 0;
  const expectedChallenge2 = value.player2.massG < value.player1.massG ? Math.min((value.player1.massG - value.player2.massG) * .05, .5) : 0;
  if (Math.abs(value.player1.score.challengePoints - expectedChallenge1) > 1e-9 || Math.abs(value.player2.score.challengePoints - expectedChallenge2) > 1e-9) context.addIssue({ code: "custom", message: "challenge points must belong only to the lighter top" });
  let logicalRound = 1; let attempt = 1;
  const ids = new Set<string>(); const tuples = new Set<string>();
  for (const round of value.rounds) {
    if (round.roundNumber !== logicalRound || round.attempt !== attempt) context.addIssue({ code: "custom", message: "round attempt sequence is invalid" });
    if (ids.has(round.externalRoundId) || tuples.has(`${round.roundNumber}:${round.attempt}`)) context.addIssue({ code: "custom", message: "round authority is duplicated" });
    ids.add(round.externalRoundId); tuples.add(`${round.roundNumber}:${round.attempt}`);
    if (round.battleResult.outcome.winner === "draw") attempt += 1; else { logicalRound += 1; attempt = 1; }
  }
});

export type CompletedMatchRecord = z.infer<typeof completedMatchRecordSchema>;

export interface MatchRepository {
  beginMatch(input: PendingMatchRecord): Promise<"created" | "replayed">;
  saveRoundAttempt(matchId: string, round: CompletedMatchRecord["rounds"][number]): Promise<"created" | "replayed">;
  saveCompletedMatch(input: CompletedMatchRecord): Promise<"created" | "replayed">;
  queueCompletion(input: CompletedMatchRecord): Promise<"created" | "replayed">;
  getRetryJob(matchId: string): Promise<MatchRetryJob | undefined>;
  listRetryable(now?: Date, limit?: number): Promise<readonly MatchRetryJob[]>;
  claimDueJobs(now?: Date, limit?: number, leaseMs?: number): Promise<readonly ClaimedMatchRetryJob[]>;
  retryFailedMatch(matchId: string, options?: Readonly<{ manual?: boolean; claimToken?: string; generation?: number }>): Promise<"created" | "replayed">;
  markPersistenceFailure?(matchId: string, sanitizedCode: string): Promise<void>;
  pruneRetention?(now?: Date, limit?: number): Promise<number>;
}
export type MatchRetryJob = Readonly<{ matchId: string; status: "pending" | "retrying" | "failed" | "completed"; attemptCount: number; nextRetryAt: Date; lastSanitizedCode: string | null; payload: CompletedMatchRecord }>;
export type ClaimedMatchRetryJob = MatchRetryJob & Readonly<{ claimToken: string; generation: number }>;

export type PendingMatchRecord = Readonly<{
  id: string; roomId: string | null; player1IdentityId: string | null; player2IdentityId: string | null;
  player1DesignId: string; player2DesignId: string; performanceModelVersion: string;
  physicsModelVersion: string; protocolVersion: number; spectatorCount: number; startedAt: Date;
}>;

export class MatchPersistenceConflictError extends Error {
  constructor() { super("MATCH_PERSISTENCE_CONFLICT"); this.name = "MatchPersistenceConflictError"; }
}

export const completedMatchFingerprint = (input: Omit<CompletedMatchRecord, "idempotencyFingerprint">): string =>
  createHash("sha256").update(JSON.stringify(input, (_key, value) => value instanceof Date ? value.toISOString() : value)).digest("hex");
const assertAuthorityFingerprint = (input: CompletedMatchRecord): void => {
  const { idempotencyFingerprint, ...payload } = input;
  if (completedMatchFingerprint(payload) !== idempotencyFingerprint) throw new MatchPersistenceConflictError();
};
const canonicalEqual = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left, (_key, value) => value instanceof Date ? value.toISOString() : value) ===
  JSON.stringify(right, (_key, value) => value instanceof Date ? value.toISOString() : value);

export class MemoryMatchRepository implements MatchRepository {
  readonly records = new Map<string, CompletedMatchRecord>();
  readonly pending = new Map<string, PendingMatchRecord>();
  readonly jobs = new Map<string, MatchRetryJob & { claimToken?: string; generation?: number; completedAt?: Date }>();
  readonly #completionRounds = new Map<string, CompletedMatchRecord["rounds"]>();
  readonly #maxJobs: number;
  readonly #completedJobTtlMs: number;
  readonly #now: () => Date;
  constructor(options: Readonly<{ maxJobs?: number; completedJobTtlMs?: number; now?: () => Date }> = {}) {
    this.#maxJobs = options.maxJobs ?? 2_000; this.#completedJobTtlMs = options.completedJobTtlMs ?? 7 * 86_400_000; this.#now = options.now ?? (() => new Date());
  }
  #pruneJobs(now = this.#now()): void { for (const [id, job] of this.jobs) if (job.status === "completed" && job.completedAt && job.completedAt.getTime() + this.#completedJobTtlMs <= now.getTime()) { this.jobs.delete(id); this.#completionRounds.delete(id); } }
  #hydrateJob(job: MatchRetryJob & { claimToken?: string; generation?: number; completedAt?: Date }): typeof job {
    const rounds = this.#completionRounds.get(job.matchId);
    return rounds ? { ...job, payload: { ...job.payload, rounds: structuredClone(rounds) } } : job;
  }
  async beginMatch(input: PendingMatchRecord): Promise<"created" | "replayed"> {
    const existing = this.pending.get(input.id);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(input)) throw new MatchPersistenceConflictError();
      return "replayed";
    }
    this.pending.set(input.id, structuredClone(input));
    return "created";
  }
  async saveCompletedMatch(input: CompletedMatchRecord): Promise<"created" | "replayed"> {
    const parsed = completedMatchRecordSchema.parse(input);
    assertAuthorityFingerprint(parsed);
    const existing = this.records.get(parsed.id);
    if (existing) {
      if (existing.idempotencyFingerprint !== parsed.idempotencyFingerprint) throw new MatchPersistenceConflictError();
      return "replayed";
    }
    this.records.set(parsed.id, structuredClone(parsed));
    this.pending.delete(parsed.id);
    return "created";
  }
  async saveRoundAttempt(matchId: string, round: CompletedMatchRecord["rounds"][number]): Promise<"created" | "replayed"> {
    const pending = this.pending.get(matchId);
    round = roundSchema.parse(round);
    if (Buffer.byteLength(JSON.stringify(round.battleResult), "utf8") > 2_097_152) throw new RangeError("BATTLE_RESULT_TOO_LARGE");
    if (!pending) throw new MatchPersistenceConflictError();
    const bucket = (pending as PendingMatchRecord & { attempts?: Map<string, CompletedMatchRecord["rounds"][number]> }).attempts ?? new Map();
    const existing = [...bucket.values()].find((candidate) => candidate.id === round.id || candidate.externalRoundId === round.externalRoundId || (candidate.roundNumber === round.roundNumber && candidate.attempt === round.attempt));
    if (existing) {
      if (!canonicalEqual(existing, round)) throw new MatchPersistenceConflictError();
      return "replayed";
    }
    bucket.set(round.externalRoundId, structuredClone(round));
    (pending as PendingMatchRecord & { attempts?: Map<string, CompletedMatchRecord["rounds"][number]> }).attempts = bucket;
    return "created";
  }
  async queueCompletion(input: CompletedMatchRecord): Promise<"created" | "replayed"> {
    const parsed = completedMatchRecordSchema.parse(input); assertAuthorityFingerprint(parsed);
    const summary = { ...parsed, rounds: parsed.rounds.map((round) => ({ ...round, battleResult: { ...round.battleResult, frames: [] } })) };
    if (Buffer.byteLength(JSON.stringify(summary), "utf8") > 65_536) throw new RangeError("MATCH_COMPLETION_SUMMARY_TOO_LARGE");
    this.#pruneJobs();
    const existing = this.jobs.get(parsed.id);
    if (existing) { if (existing.payload.idempotencyFingerprint !== parsed.idempotencyFingerprint) throw new MatchPersistenceConflictError(); return "replayed"; }
    if (this.jobs.size >= this.#maxJobs) throw new Error("MATCH_JOB_CAPACITY");
    this.jobs.set(parsed.id, { matchId: parsed.id, status: "pending", attemptCount: 0, nextRetryAt: this.#now(), lastSanitizedCode: null, payload: structuredClone(summary) });
    this.#completionRounds.set(parsed.id, structuredClone(parsed.rounds));
    return "created";
  }
  async getRetryJob(matchId: string): Promise<MatchRetryJob | undefined> { this.#pruneJobs(); const job = this.jobs.get(matchId); return job ? structuredClone(this.#hydrateJob(job)) : undefined; }
  async listRetryable(now = new Date(), limit = 100): Promise<readonly MatchRetryJob[]> { if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) throw new RangeError("invalid retry limit"); this.#pruneJobs(now); return [...this.jobs.values()].filter((job) => job.status !== "completed" && job.nextRetryAt <= now).sort((a, b) => a.nextRetryAt.getTime() - b.nextRetryAt.getTime() || a.matchId.localeCompare(b.matchId)).slice(0, limit).map((job) => structuredClone(this.#hydrateJob(job))); }
  async claimDueJobs(now = new Date(), limit = 100, leaseMs = 30_000): Promise<readonly ClaimedMatchRetryJob[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) throw new RangeError("invalid retry limit");
    this.#pruneJobs(now);
    const due = [...this.jobs.values()].filter((job) => job.status !== "completed" && job.attemptCount < 10 && job.nextRetryAt <= now).sort((a, b) => a.nextRetryAt.getTime() - b.nextRetryAt.getTime() || a.matchId.localeCompare(b.matchId)).slice(0, limit);
    return due.map((job) => {
      const claimToken = randomUUID(); const generation = (job.generation ?? 0) + 1;
      const claimed = { ...job, status: "retrying" as const, attemptCount: job.attemptCount + 1, nextRetryAt: new Date(now.getTime() + leaseMs), claimToken, generation };
      this.jobs.set(job.matchId, claimed);
      return structuredClone({ ...this.#hydrateJob(claimed), claimToken, generation });
    });
  }
  async retryFailedMatch(matchId: string, options: Readonly<{ manual?: boolean; claimToken?: string; generation?: number }> = {}): Promise<"created" | "replayed"> {
    const job = this.jobs.get(matchId); if (!job) throw new MatchPersistenceConflictError();
    if (job.status === "completed") return "replayed";
    const claimed = options.claimToken !== undefined;
    if (!claimed && !options.manual && job.attemptCount >= 10) throw new MatchPersistenceConflictError();
    if (claimed && (job.claimToken !== options.claimToken || job.generation !== options.generation || job.status !== "retrying")) throw new MatchPersistenceConflictError();
    const attemptCount = claimed ? job.attemptCount : job.attemptCount + 1;
    this.jobs.set(matchId, { ...job, status: "retrying", attemptCount, nextRetryAt: claimed ? job.nextRetryAt : new Date(Date.now() + 30_000), lastSanitizedCode: null });
    try { const result = await this.saveCompletedMatch(this.#hydrateJob(job).payload); this.jobs.set(matchId, { ...this.jobs.get(matchId)!, status: "completed", completedAt: this.#now(), lastSanitizedCode: null }); return result; }
    catch (error) {
      const manualOnly = error instanceof MatchPersistenceConflictError || error instanceof z.ZodError || error instanceof RangeError;
      const exhausted = attemptCount >= 10;
      const delay = Math.min(300_000, 1_000 * (2 ** Math.max(0, attemptCount - 1)));
      this.jobs.set(matchId, { ...this.jobs.get(matchId)!, status: "failed", nextRetryAt: new Date(manualOnly || exhausted ? 8_640_000_000_000_000 : Date.now() + delay), lastSanitizedCode: manualOnly ? "MATCH_PERSISTENCE_CONFLICT" : exhausted ? "MATCH_RETRY_EXHAUSTED" : "MATCH_SAVE_FAILED" });
      throw error;
    }
  }
  async markPersistenceFailure(matchId: string, sanitizedCode: string): Promise<void> {
    const job = this.jobs.get(matchId); if (!job || job.status === "completed" || (job.status === "retrying" && job.nextRetryAt > this.#now())) return;
    this.jobs.set(matchId, { ...job, status: "failed", lastSanitizedCode: /^[A-Z0-9_]{1,128}$/.test(sanitizedCode) ? sanitizedCode : "PERSISTENCE_FAILED" });
  }
  async pruneRetention(now = this.#now(), limit = 1_000): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5_000) throw new RangeError("invalid prune limit");
    let removed = 0;
    for (const [id, job] of this.jobs) if (removed < limit && job.status === "completed" && job.completedAt && job.completedAt.getTime() + this.#completedJobTtlMs <= now.getTime()) { this.jobs.delete(id); this.#completionRounds.delete(id); removed++; }
    return removed;
  }
}

type Db = DatabaseClient["db"];
type MatchBeginStageCode =
  | "MATCH_BEGIN_MATCH_INSERT_FAILED"
  | "MATCH_BEGIN_IDENTITY_READ_FAILED"
  | "MATCH_BEGIN_CANONICAL_READ_FAILED"
  | "MATCH_BEGIN_SNAPSHOT_INSERT_FAILED"
  | "MATCH_BEGIN_TRANSACTION_FAILED";
class MatchBeginStageError extends Error {
  readonly code: MatchBeginStageCode;
  override readonly cause: unknown;
  constructor(code: MatchBeginStageCode, cause: unknown) { super(code); this.name = "MatchBeginStageError"; this.code = code; this.cause = cause; }
}
export async function runMatchBeginStage<T>(code: MatchBeginStageCode, operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) { if (error instanceof MatchBeginStageError || error instanceof MatchPersistenceConflictError) throw error; throw new MatchBeginStageError(code, error); }
}
const persistedRoundProjection = (row: typeof rounds.$inferSelect | typeof rounds.$inferInsert) => ({
  id: row.id, matchId: row.matchId, externalRoundId: row.externalRoundId, authorityKeyHash: row.authorityKeyHash,
  roundNumber: row.roundNumber, attempt: row.attempt, seed: row.seed, outcome: row.outcome, outcomeReason: row.outcomeReason,
  ticks: row.ticks, launchGradeA: row.launchGradeA, launchGradeB: row.launchGradeB,
  launchAngularMultiplierA: Number(row.launchAngularMultiplierA), launchAngularMultiplierB: Number(row.launchAngularMultiplierB),
  launchLinearMultiplierA: Number(row.launchLinearMultiplierA), launchLinearMultiplierB: Number(row.launchLinearMultiplierB),
  physicsModelVersion: row.physicsModelVersion, inputFingerprint: row.inputFingerprint,
  battleResultJson: row.battleResultJson, startedAt: row.startedAt?.toISOString(), completedAt: row.completedAt.toISOString(),
});
const sameRound = (left: typeof rounds.$inferSelect | typeof rounds.$inferInsert, right: typeof rounds.$inferSelect | typeof rounds.$inferInsert) =>
  JSON.stringify(persistedRoundProjection(left)) === JSON.stringify(persistedRoundProjection(right));

export class PostgresMatchRepository implements MatchRepository {
  constructor(readonly db: Db) {}
  async beginMatch(input: PendingMatchRecord): Promise<"created" | "replayed"> {
    const pendingFingerprint = createHash("sha256").update(JSON.stringify(input, (_key, value) => value instanceof Date ? value.toISOString() : value)).digest("hex");
    const inserted = await runMatchBeginStage("MATCH_BEGIN_TRANSACTION_FAILED", () => this.db.transaction(async (tx) => {
      const created = await runMatchBeginStage("MATCH_BEGIN_MATCH_INSERT_FAILED", () => tx.insert(matches).values({ id: input.id, roomId: input.roomId, idempotencyFingerprint: pendingFingerprint, status: "in_progress", player1IdentityId: input.player1IdentityId, player2IdentityId: input.player2IdentityId, player1DesignId: input.player1DesignId, player2DesignId: input.player2DesignId, performanceModelVersion: input.performanceModelVersion, physicsModelVersion: input.physicsModelVersion, protocolVersion: input.protocolVersion, spectatorCount: input.spectatorCount, startedAt: input.startedAt }).onConflictDoNothing().returning({ id: matches.id }));
      if (created.length !== 1) return false;
      for (const participant of [{ slot: "player1" as const, identityId: input.player1IdentityId, designId: input.player1DesignId }, { slot: "player2" as const, identityId: input.player2IdentityId, designId: input.player2DesignId }]) {
        const [identity] = participant.identityId ? await runMatchBeginStage("MATCH_BEGIN_IDENTITY_READ_FAILED", () => tx.select().from(identities).where(eq(identities.id, participant.identityId!)).limit(1)) : [];
        const canonical = participant.identityId ? await runMatchBeginStage("MATCH_BEGIN_CANONICAL_READ_FAILED", () => tx.execute<{ id: string }>(sql`with recursive chain as (select id,merged_into_identity_id,0 depth from identities where id=${participant.identityId} union all select i.id,i.merged_into_identity_id,c.depth+1 from identities i join chain c on i.id=c.merged_into_identity_id where c.depth<16) select id from chain order by depth desc limit 1`)) : [];
        await runMatchBeginStage("MATCH_BEGIN_SNAPSHOT_INSERT_FAILED", () => tx.insert(matchParticipantSnapshots).values({ matchId: input.id, slot: participant.slot, identityIdAtStart: participant.identityId, canonicalIdentityIdAtStart: canonical[0]?.id ?? participant.identityId, identityStatusSnapshot: identity?.status ?? null, displayNameSnapshot: identity?.displayName ?? null, classNameSnapshot: identity?.className ?? null, designId: participant.designId, capturedAt: input.startedAt }));
      }
      return true;
    }));
    if (inserted) return "created";
    const [existing] = await this.db.select().from(matches).where(eq(matches.id, input.id)).limit(1);
    if (existing?.idempotencyFingerprint === pendingFingerprint) return "replayed";
    throw new MatchPersistenceConflictError();
  }
  async saveCompletedMatch(input: CompletedMatchRecord): Promise<"created" | "replayed"> {
    const parsed = completedMatchRecordSchema.parse(input);
    assertAuthorityFingerprint(parsed);
    const existing = await this.db.select().from(matches).where(eq(matches.id, parsed.id)).limit(1);
    if (existing[0]?.status === "completed") {
      if (existing[0].idempotencyFingerprint !== parsed.idempotencyFingerprint) throw new MatchPersistenceConflictError();
      return "replayed";
    }
    try {
      const replayed = await this.db.transaction(async (tx) => {
        const completedRow = {
          ...buildCompletedMatchRow({
            id: parsed.id, roomId: parsed.roomId,
            idempotencyFingerprint: parsed.idempotencyFingerprint,
            player1IdentityId: parsed.player1.identityId, player2IdentityId: parsed.player2.identityId,
            player1DesignId: parsed.player1.designId, player2DesignId: parsed.player2.designId,
            roundWinners: parsed.roundWinners,
            player1: parsed.player1.score, player2: parsed.player2.score,
            performanceModelVersion: parsed.performanceModelVersion, physicsModelVersion: parsed.physicsModelVersion,
            protocolVersion: parsed.protocolVersion, spectatorCount: parsed.spectatorCount, completedAt: parsed.completedAt,
          }),
          startedAt: parsed.startedAt,
          player1Ip: parsed.player1.ip, player2Ip: parsed.player2.ip,
          player1UserAgent: parsed.player1.userAgent, player2UserAgent: parsed.player2.userAgent,
          player1DeviceName: parsed.player1.deviceName, player2DeviceName: parsed.player2.deviceName,
        };
        const [locked] = await tx.select().from(matches).where(eq(matches.id, parsed.id)).for("update").limit(1);
        if (locked?.status === "completed") {
          if (locked.idempotencyFingerprint !== parsed.idempotencyFingerprint) throw new MatchPersistenceConflictError();
          return true;
        }
        if (locked && (
          locked.roomId !== parsed.roomId || locked.player1IdentityId !== parsed.player1.identityId || locked.player2IdentityId !== parsed.player2.identityId ||
          locked.player1DesignId !== parsed.player1.designId || locked.player2DesignId !== parsed.player2.designId ||
          locked.performanceModelVersion !== parsed.performanceModelVersion || locked.physicsModelVersion !== parsed.physicsModelVersion ||
          locked.protocolVersion !== parsed.protocolVersion || locked.spectatorCount !== parsed.spectatorCount || locked.startedAt.getTime() !== parsed.startedAt.getTime()
        )) throw new MatchPersistenceConflictError();
        if (!locked) await tx.insert(matches).values({ ...completedRow, status: "in_progress", completedAt: null, winner: null, roundWinners: null, player1BattlePoints: null, player2BattlePoints: null, player1ChallengePoints: null, player2ChallengePoints: null, player1Total: null, player2Total: null });
        const roundRows = parsed.rounds.map((round) => ({
          ...buildRoundRow({
            id: round.id, matchId: parsed.id, externalRoundId: round.externalRoundId,
            roundNumber: round.roundNumber, attempt: round.attempt, inputFingerprint: round.inputFingerprint,
            launchGradeA: round.launchA.grade, launchGradeB: round.launchB.grade,
            launchAngularMultiplierA: round.launchA.angularMultiplier, launchAngularMultiplierB: round.launchB.angularMultiplier,
            launchLinearMultiplierA: round.launchA.impulseMultiplier, launchLinearMultiplierB: round.launchB.impulseMultiplier,
            completedAt: round.completedAt,
            battleResult: { ...round.battleResult, launchDiagnostics: { player1: round.launchA, player2: round.launchB } },
          }),
          startedAt: round.startedAt,
        }));
        for (const roundRow of roundRows) {
          const [storedRound] = await tx.select().from(rounds).where(or(
            eq(rounds.id, roundRow.id), eq(rounds.authorityKeyHash, roundRow.authorityKeyHash),
            and(eq(rounds.matchId, roundRow.matchId), eq(rounds.externalRoundId, roundRow.externalRoundId)),
            and(eq(rounds.matchId, roundRow.matchId), eq(rounds.roundNumber, roundRow.roundNumber), eq(rounds.attempt, roundRow.attempt)),
          )).limit(1);
          if (storedRound && !sameRound(storedRound, roundRow)) throw new MatchPersistenceConflictError();
          if (!storedRound) await tx.insert(rounds).values(roundRow);
        }
        const persisted = await tx.select().from(rounds).where(eq(rounds.matchId, parsed.id)).orderBy(asc(rounds.roundNumber), asc(rounds.attempt));
        if (persisted.length !== roundRows.length || roundRows.some((expected) => !persisted.some((actual) => sameRound(actual, expected)))) throw new MatchPersistenceConflictError();
        await tx.update(matches).set({ ...completedRow, persistFailureCode: null }).where(eq(matches.id, parsed.id));
        return false;
      });
      return replayed ? "replayed" : "created";
    } catch (error) {
      if ((error as { code?: string }).code !== "23505") throw error;
      const [after] = await this.db.select().from(matches).where(eq(matches.id, parsed.id)).limit(1);
      if (after?.idempotencyFingerprint === parsed.idempotencyFingerprint) return "replayed";
      throw new MatchPersistenceConflictError();
    }
  }

  async saveRoundAttempt(matchId: string, round: CompletedMatchRecord["rounds"][number]): Promise<"created" | "replayed"> {
    round = roundSchema.parse(round);
    if (Buffer.byteLength(JSON.stringify(round.battleResult), "utf8") > 2_097_152) throw new RangeError("BATTLE_RESULT_TOO_LARGE");
    const value = {
      ...buildRoundRow({
        id: round.id, matchId, externalRoundId: round.externalRoundId, roundNumber: round.roundNumber,
        attempt: round.attempt, inputFingerprint: round.inputFingerprint,
        launchGradeA: round.launchA.grade, launchGradeB: round.launchB.grade,
        launchAngularMultiplierA: round.launchA.angularMultiplier, launchAngularMultiplierB: round.launchB.angularMultiplier,
        launchLinearMultiplierA: round.launchA.impulseMultiplier, launchLinearMultiplierB: round.launchB.impulseMultiplier,
        completedAt: round.completedAt,
        battleResult: { ...round.battleResult, launchDiagnostics: { player1: round.launchA, player2: round.launchB } },
      }),
      startedAt: round.startedAt,
    };
    return this.db.transaction(async (tx) => {
      const [existing] = await tx.select().from(rounds).where(or(
        eq(rounds.id, value.id), eq(rounds.authorityKeyHash, value.authorityKeyHash),
        and(eq(rounds.matchId, value.matchId), eq(rounds.externalRoundId, value.externalRoundId)),
        and(eq(rounds.matchId, value.matchId), eq(rounds.roundNumber, value.roundNumber), eq(rounds.attempt, value.attempt)),
      )).for("update").limit(1);
      if (existing) {
        if (!sameRound(existing, value)) throw new MatchPersistenceConflictError();
        return "replayed" as const;
      }
      await tx.insert(rounds).values(value);
      return "created" as const;
    });
  }

  async markPersistenceFailure(matchId: string, sanitizedCode: string): Promise<void> {
    const code = /^[A-Z0-9_]{1,128}$/.test(sanitizedCode) ? sanitizedCode : "PERSISTENCE_FAILED";
    await this.db.transaction(async (tx) => {
      const [job] = await tx.select().from(matchPersistenceJobs).where(eq(matchPersistenceJobs.matchId, matchId)).for("update").limit(1);
      if (job?.status === "completed" || (job?.status === "retrying" && job.nextRetryAt > new Date())) return;
      await tx.update(matches).set({ status: "persist_failed", persistFailureCode: code }).where(and(eq(matches.id, matchId), ne(matches.status, "completed")));
      await tx.update(matchPersistenceJobs).set({ status: "failed", claimToken: null, leaseUntil: null, lastSanitizedCode: code, updatedAt: new Date() }).where(and(eq(matchPersistenceJobs.matchId, matchId), ne(matchPersistenceJobs.status, "completed")));
    });
  }
  async pruneRetention(now = new Date(), limit = 1_000): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5_000) throw new RangeError("invalid prune limit");
    const rows = await this.db.execute(sql`with expired as (select match_id from match_persistence_jobs where status='completed' and completed_at < ${new Date(now.getTime() - 7 * 86_400_000)} order by completed_at limit ${limit} for update skip locked) delete from match_persistence_jobs j using expired where j.match_id=expired.match_id and j.status='completed' returning j.match_id`);
    return rows.length;
  }

  async queueCompletion(input: CompletedMatchRecord): Promise<"created" | "replayed"> {
    const parsed = completedMatchRecordSchema.parse(input); assertAuthorityFingerprint(parsed);
    const summary = { ...parsed, rounds: parsed.rounds.map((round) => ({ ...round, battleResult: { ...round.battleResult, frames: [] } })) };
    const serialized = JSON.stringify(summary);
    if (Buffer.byteLength(serialized, "utf8") > 65_536) throw new RangeError("MATCH_COMPLETION_SUMMARY_TOO_LARGE");
    const payload = JSON.parse(serialized) as Readonly<Record<string, unknown>>;
    const inserted = await this.db.insert(matchPersistenceJobs).values({ matchId: parsed.id, inputFingerprint: parsed.idempotencyFingerprint, completionPayload: payload, status: "pending", nextRetryAt: new Date() }).onConflictDoNothing().returning({ matchId: matchPersistenceJobs.matchId });
    if (inserted.length) return "created";
    const [existing] = await this.db.select().from(matchPersistenceJobs).where(eq(matchPersistenceJobs.matchId, parsed.id)).limit(1);
    if (existing?.inputFingerprint === parsed.idempotencyFingerprint) return "replayed";
    throw new MatchPersistenceConflictError();
  }
  #decodeJob(row: typeof matchPersistenceJobs.$inferSelect, persistedRounds: readonly (typeof rounds.$inferSelect)[]): MatchRetryJob {
    if (Buffer.byteLength(JSON.stringify(row.completionPayload), "utf8") > 65_536) throw new RangeError("MATCH_COMPLETION_SUMMARY_TOO_LARGE");
    const raw = row.completionPayload as Record<string, unknown>;
    const roundsPayload = (raw.rounds as Array<Record<string, unknown>>).map((round) => {
      const stored = persistedRounds.find((candidate) => candidate.id === round.id);
      if (!stored || stored.externalRoundId !== round.externalRoundId || stored.inputFingerprint !== round.inputFingerprint || stored.roundNumber !== round.roundNumber || stored.attempt !== round.attempt) throw new MatchPersistenceConflictError();
      const { launchDiagnostics: _diagnostics, ...battleResult } = stored.battleResultJson as Record<string, unknown>;
      return { ...round, battleResult, startedAt: new Date(String(round.startedAt)), completedAt: new Date(String(round.completedAt)) };
    });
    const payload = completedMatchRecordSchema.parse({ ...raw, startedAt: new Date(String(raw.startedAt)), completedAt: new Date(String(raw.completedAt)), rounds: roundsPayload });
    return { matchId: row.matchId, status: row.status as MatchRetryJob["status"], attemptCount: row.attemptCount, nextRetryAt: row.nextRetryAt, lastSanitizedCode: row.lastSanitizedCode, payload };
  }
  async getRetryJob(matchId: string): Promise<MatchRetryJob | undefined> { const [row] = await this.db.select().from(matchPersistenceJobs).where(eq(matchPersistenceJobs.matchId, matchId)).limit(1); if (!row) return undefined; const stored = await this.db.select().from(rounds).where(eq(rounds.matchId, matchId)); return this.#decodeJob(row, stored); }
  async listRetryable(now = new Date(), limit = 100): Promise<readonly MatchRetryJob[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) throw new RangeError("invalid retry limit");
    const rows = await this.db.select().from(matchPersistenceJobs).where(and(inArray(matchPersistenceJobs.status, ["pending", "failed", "retrying"]), lte(matchPersistenceJobs.nextRetryAt, now))).orderBy(asc(matchPersistenceJobs.nextRetryAt), asc(matchPersistenceJobs.createdAt)).limit(limit);
    const stored = rows.length ? await this.db.select().from(rounds).where(inArray(rounds.matchId, rows.map((row) => row.matchId))) : [];
    return rows.map((row) => this.#decodeJob(row, stored.filter((round) => round.matchId === row.matchId)));
  }
  async claimDueJobs(now = new Date(), limit = 100, leaseMs = 30_000): Promise<readonly ClaimedMatchRetryJob[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) throw new RangeError("invalid retry limit");
    return this.db.transaction(async (tx) => {
      const rows = await tx.select().from(matchPersistenceJobs).where(and(
        inArray(matchPersistenceJobs.status, ["pending", "failed", "retrying"]),
        lt(matchPersistenceJobs.attemptCount, 10),
        lte(matchPersistenceJobs.nextRetryAt, now),
      )).orderBy(asc(matchPersistenceJobs.nextRetryAt), asc(matchPersistenceJobs.createdAt)).limit(limit).for("update", { skipLocked: true });
      if (!rows.length) return [];
      const stored = await tx.select().from(rounds).where(inArray(rounds.matchId, rows.map((row) => row.matchId)));
      const claims: ClaimedMatchRetryJob[] = [];
      for (const row of rows) {
        const claimToken = randomUUID(); const generation = row.generation + 1;
        const nextRetryAt = new Date(now.getTime() + leaseMs); const attemptCount = row.attemptCount + 1;
        await tx.update(matchPersistenceJobs).set({ status: "retrying", attemptCount, claimToken, generation, leaseUntil: nextRetryAt, nextRetryAt, lastSanitizedCode: null, updatedAt: now }).where(and(eq(matchPersistenceJobs.matchId, row.matchId), eq(matchPersistenceJobs.generation, row.generation)));
        claims.push({ ...this.#decodeJob({ ...row, status: "retrying", attemptCount, claimToken, generation, leaseUntil: nextRetryAt, nextRetryAt }, stored.filter((round) => round.matchId === row.matchId)), claimToken, generation });
      }
      return claims;
    });
  }
  async retryFailedMatch(matchId: string, options: Readonly<{ manual?: boolean; claimToken?: string; generation?: number }> = {}): Promise<"created" | "replayed"> {
    const job = await this.db.transaction(async (tx) => {
      const [row] = await tx.select().from(matchPersistenceJobs).where(eq(matchPersistenceJobs.matchId, matchId)).for("update").limit(1);
      if (!row) throw new MatchPersistenceConflictError();
      if (row.status === "completed") return null;
      const claimed = options.claimToken !== undefined;
      if (!claimed && !options.manual && row.attemptCount >= 10) throw new MatchPersistenceConflictError();
      if (claimed && (row.claimToken !== options.claimToken || row.generation !== options.generation || row.status !== "retrying")) throw new MatchPersistenceConflictError();
      if (!claimed && row.status === "retrying" && row.nextRetryAt > new Date()) throw new MatchPersistenceConflictError();
      const attemptCount = claimed ? row.attemptCount : row.attemptCount + 1;
      const claimToken = claimed ? row.claimToken! : randomUUID();
      const generation = claimed ? row.generation : row.generation + 1;
      const leaseUntil = claimed ? row.leaseUntil! : new Date(Date.now() + 30_000);
      if (!claimed) await tx.update(matchPersistenceJobs).set({ status: "retrying", attemptCount, claimToken, generation, leaseUntil, nextRetryAt: leaseUntil, lastSanitizedCode: null, updatedAt: new Date() }).where(eq(matchPersistenceJobs.matchId, matchId));
      const stored = await tx.select().from(rounds).where(eq(rounds.matchId, matchId));
      return { job: this.#decodeJob({ ...row, status: "retrying", attemptCount, claimToken, generation, leaseUntil, nextRetryAt: leaseUntil }, stored), attemptCount, claimToken, generation };
    });
    if (!job) return "replayed";
    try {
      const result = await this.saveCompletedMatch(job.job.payload);
      const completed = await this.db.update(matchPersistenceJobs).set({ status: "completed", completedAt: new Date(), claimToken: null, leaseUntil: null, lastSanitizedCode: null, updatedAt: new Date() }).where(and(eq(matchPersistenceJobs.matchId, matchId), eq(matchPersistenceJobs.claimToken, job.claimToken), eq(matchPersistenceJobs.generation, job.generation))).returning({ matchId: matchPersistenceJobs.matchId });
      if (completed.length !== 1) throw new MatchPersistenceConflictError();
      return result;
    } catch (error) {
      const manualOnly = error instanceof MatchPersistenceConflictError || error instanceof z.ZodError || error instanceof RangeError;
      const exhausted = job.attemptCount >= 10;
      const jitter = Number.parseInt(createHash("sha256").update(`${matchId}:${job.attemptCount}`).digest("hex").slice(0, 2), 16) / 255 * .2;
      const delay = Math.min(300_000, Math.round(1_000 * (2 ** Math.max(0, job.attemptCount - 1)) * (1 + jitter)));
      await this.db.update(matchPersistenceJobs).set({ status: "failed", claimToken: null, leaseUntil: null, nextRetryAt: new Date(manualOnly || exhausted ? 8_640_000_000_000_000 : Date.now() + delay), lastSanitizedCode: manualOnly ? "MATCH_PERSISTENCE_CONFLICT" : exhausted ? "MATCH_RETRY_EXHAUSTED" : "MATCH_SAVE_FAILED", updatedAt: new Date() }).where(and(eq(matchPersistenceJobs.matchId, matchId), eq(matchPersistenceJobs.claimToken, job.claimToken), eq(matchPersistenceJobs.generation, job.generation)));
      throw error;
    }
  }
}
