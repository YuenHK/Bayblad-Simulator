import { makeDefaultDesign } from "@steam-top/domain";
import { describe, expect, it, vi } from "vitest";
import { MemoryDesignRepository } from "./design-repository";
import { completedMatchFingerprint, completedMatchRecordSchema, MatchPersistenceConflictError, MemoryMatchRepository, type CompletedMatchRecord } from "./match-repository";
import { RoomProjectionCoordinator } from "./room-projection-coordinator";
import { MemoryRoomProjectionStore } from "./room-projection-store";

const id = (suffix: number) => `00000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
const round = (index: number, roundNumber: number, attempt: number, winner: "player1" | "player2" | "draw"): CompletedMatchRecord["rounds"][number] => ({
  id: id(100 + index), externalRoundId: `round-${index}`, roundNumber, attempt,
  inputFingerprint: "a".repeat(64),
  launchA: { grade: "Great" as const, angularMultiplier: 1, impulseMultiplier: 1, tapReceivedAtMs: null, tapOffsetMs: null },
  launchB: { grade: "Good" as const, angularMultiplier: .9, impulseMultiplier: .9, tapReceivedAtMs: null, tapOffsetMs: null },
  startedAt: new Date("2026-08-29T00:00:00Z"), completedAt: new Date("2026-08-29T00:00:01Z"),
  battleResult: { modelVersion: "2.0.0", seed: index, ticks: 60, frames: [], outcome: { winner, reason: winner === "draw" ? "simultaneous" as const : "stopped" as const }, finalStats: { player1: { angularSpeed: 1, speedMps: 0, energyJ: 1, stoppedTicks: 0, impactRetentionProduct: 1 }, player2: { angularSpeed: 1, speedMps: 0, energyJ: 1, stoppedTicks: 0, impactRetentionProduct: 1 }, topTopContactCount: 0, topTopBeginContactEpisodes: 0, topTopImpactApplications: 0 } },
});
const fixture = (): CompletedMatchRecord => {
 const base = {
  id: id(1), roomId: null,
  player1: { identityId: id(2), identitySource: "iclass", deviceName: "1A-01", ip: "192.0.2.1", userAgent: "iPad", designId: id(4), massG: 40, score: { battlePoints: 2, challengePoints: .5, total: 2.5 } },
  player2: { identityId: id(3), identitySource: "guest", deviceName: null, ip: "192.0.2.2", userAgent: "Safari", designId: id(5), massG: 50, score: { battlePoints: 0, challengePoints: 0, total: 0 } },
  roundWinners: ["player1", "player1"], rounds: [round(1, 1, 1, "draw"), round(2, 1, 2, "player1"), round(3, 2, 1, "player1")],
  performanceModelVersion: "1.0.0", physicsModelVersion: "2.0.0", protocolVersion: 1, spectatorCount: 20,
  startedAt: new Date("2026-08-29T00:00:00Z"), completedAt: new Date("2026-08-29T00:01:00Z"),
 } satisfies Omit<CompletedMatchRecord, "idempotencyFingerprint">;
 return completedMatchRecordSchema.parse({ ...base, idempotencyFingerprint: completedMatchFingerprint(base) });
};

describe("durable record contracts", () => {
  it("durably keeps only the newest room projection across coordinator restarts", async () => {
    const store = new MemoryRoomProjectionStore({ maxEntries: 2, leaseMs: 1_000, now: () => new Date("2026-08-29T00:00:00Z") });
    const applied: number[] = [];
    await store.enqueue({ roomId: id(90), revision: 2, payload: { phase: "battle", firstBattleAt: null, closedAt: null } });
    await store.enqueue({ roomId: id(90), revision: 1, payload: { phase: "launch", firstBattleAt: null, closedAt: null } });
    const first = new RoomProjectionCoordinator({ store, apply: async (job) => { applied.push(job.revision); throw new Error("offline"); }, report: () => undefined });
    await first.pump(new Date("2026-08-29T00:00:00Z"));
    await first.close();
    const second = new RoomProjectionCoordinator({ store, apply: async (job) => { applied.push(job.revision); } });
    await second.pump(new Date("2026-08-29T00:00:02Z"));
    expect(applied).toEqual([2, 2]);
    expect(store.size).toBe(0);
    await second.close();
  });

  it("claims each due room projection once across workers and refuses capacity loss", async () => {
    const store = new MemoryRoomProjectionStore({ maxEntries: 1, now: () => new Date("2026-08-29T00:00:00Z") });
    await store.enqueue({ roomId: id(91), revision: 1, payload: { phase: "waiting", firstBattleAt: null, closedAt: null } });
    await expect(store.enqueue({ roomId: id(92), revision: 1, payload: { phase: "waiting", firstBattleAt: null, closedAt: null } })).rejects.toThrow("ROOM_PROJECTION_CAPACITY");
    const now = new Date("2026-08-29T00:00:00Z");
    const [left, right] = await Promise.all([store.claimDue(1, now), store.claimDue(1, now)]);
    expect(left.length + right.length).toBe(1);
  });

  it("rejects a different payload at the same room revision", async () => {
    const store = new MemoryRoomProjectionStore();
    await store.enqueue({ roomId: id(95), revision: 7, payload: { phase: "battle", firstBattleAt: null, closedAt: null } });
    await expect(store.enqueue({ roomId: id(95), revision: 7, payload: { phase: "waiting", firstBattleAt: null, closedAt: null } })).rejects.toThrow("ROOM_PROJECTION_CONFLICT");
  });

  it("never claims prepared or aborted projections and fences commit tokens", async () => {
    const store = new MemoryRoomProjectionStore(); const roomId = id(96);
    const first = await store.prepare({ roomId, revision: 8, payload: { phase: "battle", firstBattleAt: null, closedAt: null } });
    expect(await store.claimDue(1)).toHaveLength(0);
    expect(await store.abortPrepared(first)).toBe(true);
    const replacement = await store.prepare({ roomId, revision: 8, payload: { phase: "waiting", firstBattleAt: null, closedAt: null } });
    expect(await store.commitPrepared(first)).toBe(false);
    expect(await store.commitPrepared(replacement)).toBe(true);
    expect(await store.claimDue(1)).toHaveLength(1);
  });

  it("fails admission at the durable boundary and close surfaces an in-flight enqueue failure", async () => {
    let reject!: (error: Error) => void;
    class FailingStore extends MemoryRoomProjectionStore {
      override async enqueue() { return new Promise<"created">((_resolve, rejectPromise) => { reject = rejectPromise; }); }
    }
    const coordinator = new RoomProjectionCoordinator({ store: new FailingStore(), apply: async () => undefined });
    const admission = coordinator.enqueueProjection({ roomId: id(93), revision: 1, payload: { phase: "waiting", firstBattleAt: null, closedAt: null } });
    const closing = coordinator.close();
    reject(new Error("offline"));
    await expect(admission).rejects.toThrow("offline");
    await expect(closing).rejects.toThrow("offline");
  });
  it("reuses an identical canonical design for one identity and enforces ownership", async () => {
    const repository = new MemoryDesignRepository();
    const design = makeDefaultDesign();
    const first = await repository.saveBattleEligible(id(2), design);
    const replay = await repository.saveBattleEligible(id(2), { ...design, name: `  ${design.name}  ` });
    expect(replay.designId).toBe(first.designId);
    expect(await repository.getOwned(id(3), first.designId)).toBeUndefined();
    expect(await repository.getOwned(id(2), first.designId)).toMatchObject({ massG: expect.any(Number) });
  });

  it("rejects invalid drafts instead of marking them battle eligible", async () => {
    const repository = new MemoryDesignRepository();
    await expect(repository.saveBattleEligible(id(2), { ...makeDefaultDesign(), metalDiscDiameterMm: 9 })).rejects.toThrow();
  });

  it("stores draws for diagnostics but excludes them from round winners", async () => {
    const repository = new MemoryMatchRepository();
    const match = fixture();
    await repository.beginMatch({
      id: match.id, roomId: match.roomId,
      player1IdentityId: match.player1.identityId, player2IdentityId: match.player2.identityId,
      player1DesignId: match.player1.designId, player2DesignId: match.player2.designId,
      performanceModelVersion: match.performanceModelVersion, physicsModelVersion: match.physicsModelVersion,
      protocolVersion: match.protocolVersion, spectatorCount: match.spectatorCount, startedAt: match.startedAt,
    });
    for (const attempt of match.rounds) await repository.saveRoundAttempt(match.id, attempt);
    await expect(repository.saveCompletedMatch(match)).resolves.toBe("created");
    await expect(repository.saveCompletedMatch(structuredClone(match))).resolves.toBe("replayed");
    expect(repository.records.get(match.id)?.rounds).toHaveLength(3);
    expect(repository.records.get(match.id)?.roundWinners).toEqual(["player1", "player1"]);
  });

  it("rejects a different payload under the same match authority", async () => {
    const repository = new MemoryMatchRepository();
    const match = fixture();
    await repository.saveCompletedMatch(match);
    await expect(repository.saveCompletedMatch({ ...match, spectatorCount: 21 })).rejects.toBeInstanceOf(MatchPersistenceConflictError);
  });

  it("durably queues an immutable completion and completes it exactly once", async () => {
    const repository = new MemoryMatchRepository();
    const match = fixture();
    await expect(repository.queueCompletion(match)).resolves.toBe("created");
    await expect(repository.queueCompletion(structuredClone(match))).resolves.toBe("replayed");
    expect((await repository.getRetryJob(match.id))?.status).toBe("pending");
    await expect(repository.retryFailedMatch(match.id)).resolves.toBe("created");
    expect((await repository.getRetryJob(match.id))?.status).toBe("completed");
    expect(await repository.listRetryable(new Date("2099-01-01"))).toHaveLength(0);
  });

  it("atomically claims due match completions once across workers", async () => {
    const repository = new MemoryMatchRepository();
    const match = fixture();
    await repository.queueCompletion(match);
    const now = new Date("2099-01-01T00:00:00Z");
    const [left, right] = await Promise.all([
      repository.claimDueJobs(now, 1),
      repository.claimDueJobs(now, 1),
    ]);
    expect(left.length + right.length).toBe(1);
    const claim = [...left, ...right][0]!;
    await expect(repository.retryFailedMatch(claim.matchId, { claimToken: claim.claimToken, generation: claim.generation })).resolves.toBe("created");
    expect((await repository.getRetryJob(match.id))?.status).toBe("completed");
  });

  it("never evicts pending match jobs at capacity and reclaims completed TTL entries", async () => {
    let now = new Date("2026-08-29T00:00:00Z");
    const repository = new MemoryMatchRepository({ maxJobs: 1, completedJobTtlMs: 1_000, now: () => now });
    const first = fixture();
    const { idempotencyFingerprint: _old, ...secondPayload } = { ...fixture(), id: id(50) };
    const second = { ...secondPayload, idempotencyFingerprint: completedMatchFingerprint(secondPayload) };
    await repository.queueCompletion(first);
    await expect(repository.queueCompletion(second)).rejects.toThrow("MATCH_JOB_CAPACITY");
    await repository.retryFailedMatch(first.id);
    now = new Date(now.getTime() + 1_001);
    await expect(repository.queueCompletion(second)).resolves.toBe("created");
  });

  it("executes the tenth claimed completion attempt once and then terminalizes it", async () => {
    class AlwaysFailRepository extends MemoryMatchRepository {
      calls = 0;
      override async saveCompletedMatch(): Promise<"created"> { this.calls += 1; throw new Error("offline"); }
    }
    const repository = new AlwaysFailRepository();
    await repository.queueCompletion(fixture());
    for (let attempt = 1; attempt <= 10; attempt += 1) {
      const [claim] = await repository.claimDueJobs(new Date("2099-01-01"), 1);
      expect(claim?.attemptCount).toBe(attempt);
      await expect(repository.retryFailedMatch(claim!.matchId, { claimToken: claim!.claimToken, generation: claim!.generation })).rejects.toThrow("offline");
    }
    expect(repository.calls).toBe(10);
    expect(await repository.claimDueJobs(new Date("9999-01-01"), 1)).toHaveLength(0);
  });

  it("prunes only terminal envelopes after their bounded retention windows", async () => {
    let now = new Date("2026-08-29T00:00:00Z");
    const matches = new MemoryMatchRepository({ now: () => now });
    const match = fixture(); await matches.queueCompletion(match); await matches.retryFailedMatch(match.id);
    expect(await matches.pruneRetention(new Date(now.getTime() + 6 * 86_400_000))).toBe(0);
    expect(await matches.pruneRetention(new Date(now.getTime() + 8 * 86_400_000))).toBe(1);
    const projections = new MemoryRoomProjectionStore({ maxAttempts: 1, now: () => now });
    await projections.enqueue({ roomId: id(94), revision: 1, payload: { phase: "closed", firstBattleAt: null, closedAt: now.toISOString() } });
    const [claim] = await projections.claimDue(1, now); await projections.fail(claim!, "OFFLINE", now);
    expect(await projections.pruneDead(new Date(now.getTime() + 29 * 86_400_000))).toBe(0);
    expect(await projections.pruneDead(new Date(now.getTime() + 31 * 86_400_000))).toBe(1);
  });

  it("rejects round authority collisions even when the input hash is reused", async () => {
    const repository = new MemoryMatchRepository();
    const match = fixture();
    await repository.beginMatch({
      id: match.id, roomId: null, player1IdentityId: match.player1.identityId, player2IdentityId: match.player2.identityId,
      player1DesignId: match.player1.designId, player2DesignId: match.player2.designId,
      performanceModelVersion: match.performanceModelVersion, physicsModelVersion: match.physicsModelVersion,
      protocolVersion: match.protocolVersion, spectatorCount: 0, startedAt: match.startedAt,
    });
    await repository.saveRoundAttempt(match.id, match.rounds[0]!);
    await expect(repository.saveRoundAttempt(match.id, { ...match.rounds[0]!, battleResult: { ...match.rounds[0]!.battleResult, ticks: 61 } })).rejects.toBeInstanceOf(MatchPersistenceConflictError);
  });

  it("applies the same completed-match consistency validation in memory", async () => {
    const repository = new MemoryMatchRepository();
    const match = fixture();
    await expect(repository.saveCompletedMatch({ ...match, player1: { ...match.player1, score: { ...match.player1.score, total: 2 } } })).rejects.toThrow();
  });

  it("bounds room projection retries and keeps only the latest revision", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0; const coordinator = new RoomProjectionCoordinator();
      coordinator.enqueue("room:phase", 1, async () => { calls += 1; throw new Error("offline"); });
      coordinator.enqueue("room:phase", 2, async () => { calls += 1; throw new Error("offline"); });
      await Promise.resolve(); await Promise.resolve();
      await vi.runAllTimersAsync();
      expect(calls).toBe(11); // one superseded in-flight call plus ten bounded latest-revision attempts
      coordinator.close();
    } finally { vi.useRealTimers(); }
  });
});
