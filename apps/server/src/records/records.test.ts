import { makeDefaultDesign } from "@steam-top/domain";
import { describe, expect, it, vi } from "vitest";
import { MemoryDesignRepository } from "./design-repository";
import { completedMatchFingerprint, completedMatchRecordSchema, MatchPersistenceConflictError, MemoryMatchRepository, type CompletedMatchRecord } from "./match-repository";
import { RoomProjectionCoordinator } from "./room-projection-coordinator";

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
