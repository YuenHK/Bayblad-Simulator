import { readFileSync, readdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createDatabaseClient, type DatabaseClient } from "@steam-top/db";
import { makeDefaultDesign } from "@steam-top/domain";
import { simulateMatchRound } from "../battle/engine";
import { PostgresBattleResultRepository } from "./battle-result-repository";
import { PostgresDesignRepository } from "./design-repository";
import { completedMatchFingerprint, MatchPersistenceConflictError, PostgresMatchRepository, type CompletedMatchRecord } from "./match-repository";
import { identities } from "@steam-top/db/schema";
import { matches, roomParticipants, rooms, rounds } from "@steam-top/db/schema";
import { eq } from "drizzle-orm";
import { PostgresRoomRecordRepository } from "./room-repository";
import { PostgresRoomProjectionStore } from "./room-projection-store";

const databaseUrl = process.env.TEST_DATABASE_URL;
const schemaName = `battle_result_${randomUUID().replaceAll("-", "")}`;
let client: DatabaseClient;

beforeAll(async () => {
  if (!databaseUrl) return;
  const local = /(?:localhost|127\.0\.0\.1)/u.test(databaseUrl);
  client = createDatabaseClient({ url: databaseUrl, ssl: local ? false : "require", allowInsecure: local, maxConnections: 10 });
  await client.sql.unsafe(`create schema ${schemaName}`);
  await client.sql.unsafe(`set search_path to ${schemaName},public`);
  const directory = fileURLToPath(new URL("../../../../drizzle", import.meta.url));
  for (const file of readdirSync(directory).filter((name) => name.endsWith(".sql")).sort()) {
    for (const statement of readFileSync(`${directory}/${file}`, "utf8").split("--> statement-breakpoint").map((value) => value.trim()).filter(Boolean)) await client.sql.unsafe(statement);
  }
}, 30_000);

it.skipIf(!databaseUrl)("projects room owner, phases, first battle metadata and closure idempotently", async () => {
  const ownerIdentityId = randomUUID(); const challengerIdentityId = randomUUID(); const roomId = randomUUID();
  await client.db.insert(identities).values([{ id: ownerIdentityId, status: "guest", displayName: "Owner" }, { id: challengerIdentityId, status: "guest", displayName: "Challenger" }]);
  const repository = new PostgresRoomRecordRepository(client.db);
  const participant = (participantPublicId: string, identityId: string | null, role: "player1" | "player2" | "spectator", isOwner = false) => ({ participantPublicId, identityId, displayName: participantPublicId, role, isOwner, ip: null, userAgent: null, deviceName: null });
  const createdAt = new Date("2026-08-29T01:00:00Z"); const firstBattleAt = new Date("2026-08-29T01:01:00Z");
  await repository.create({ id: roomId, code: `PG${randomUUID().slice(0, 6)}`, name: "PG room", ownerIdentityId, participant: participant("owner", ownerIdentityId, "player1", true), at: createdAt });
  await repository.join(roomId, participant("challenger", challengerIdentityId, "player2"), createdAt);
  await repository.join(roomId, participant("watcher", null, "spectator"), createdAt);
  const roles = new Map([["owner", "spectator"], ["challenger", "player1"], ["watcher", "player2"]] as const);
  await repository.syncRoles(roomId, roles, "challenger", challengerIdentityId);
  await repository.updatePhase(roomId, "launch");
  await repository.recordBattleStart(roomId, firstBattleAt);
  await repository.updatePhase(roomId, "battle"); await repository.updatePhase(roomId, "result"); await repository.updatePhase(roomId, "waiting");
  await repository.recordBattleStart(roomId, new Date(firstBattleAt.getTime() + 10_000)); // delayed metadata retry must not regress phase
  const [beforeClose] = await client.db.select().from(rooms).where(eq(rooms.id, roomId));
  expect(beforeClose).toMatchObject({ ownerIdentityId: challengerIdentityId, status: "waiting", firstBattleAt });
  await repository.close(roomId, new Date("2026-08-29T01:05:00Z")); await repository.close(roomId, new Date("2026-08-29T01:06:00Z"));
  const [closed] = await client.db.select().from(rooms).where(eq(rooms.id, roomId));
  expect(closed).toMatchObject({ status: "closed", firstBattleAt, closedAt: new Date("2026-08-29T01:05:00Z") });
  const participants = await client.db.select().from(roomParticipants).where(eq(roomParticipants.roomId, roomId));
  expect(participants).toHaveLength(3); expect(participants.every((row) => row.leftAt !== null)).toBe(true);
}, 30_000);

it.skipIf(!databaseUrl)("keeps the newest durable room projection and claims it once across workers", async () => {
  const ownerIdentityId = randomUUID(); const roomId = randomUUID();
  await client.db.insert(identities).values({ id: ownerIdentityId, status: "guest", displayName: "Projection owner" });
  const roomsRepository = new PostgresRoomRecordRepository(client.db);
  await roomsRepository.create({ id: roomId, code: `PJ${randomUUID().slice(0, 6)}`, name: "Projection room", ownerIdentityId, participant: { participantPublicId: "projection-owner", identityId: ownerIdentityId, displayName: "Projection owner", role: "player1", isOwner: true, ip: null, userAgent: null, deviceName: null }, at: new Date() });
  const first = new PostgresRoomProjectionStore(client.db); const second = new PostgresRoomProjectionStore(client.db);
  await first.enqueue({ roomId, revision: 2, payload: { phase: "battle", firstBattleAt: "2026-08-29T02:00:00.000Z", closedAt: null } });
  await second.enqueue({ roomId, revision: 1, payload: { phase: "launch", firstBattleAt: null, closedAt: null } });
  const [left, right] = await Promise.all([first.claimDue(1, new Date("2099-01-01")), second.claimDue(1, new Date("2099-01-01"))]);
  expect(left.length + right.length).toBe(1);
  const claim = [...left, ...right][0]!;
  expect(claim).toMatchObject({ revision: 2, payload: { phase: "battle" } });
  await roomsRepository.applyProjection(roomId, claim.revision, claim.payload);
  expect(await first.complete(claim)).toBe(true);
  expect((await client.db.select().from(rooms).where(eq(rooms.id, roomId)))[0]).toMatchObject({ status: "battle", firstBattleAt: new Date("2026-08-29T02:00:00Z") });
  expect(await roomsRepository.applyProjection(roomId, 3, { phase: "result", firstBattleAt: null, closedAt: null })).toBe(true);
  expect(await roomsRepository.applyProjection(roomId, 2, { phase: "launch", firstBattleAt: null, closedAt: null })).toBe(false);
  expect((await client.db.select().from(rooms).where(eq(rooms.id, roomId)))[0]).toMatchObject({ status: "result", appliedProjectionRevision: 3 });
  await roomsRepository.transitionPhaseWithProjection(roomId, 4, { phase: "waiting", firstBattleAt: null, closedAt: null });
  const appliedTransition = (await first.claimDue(1, new Date("2099-01-01")))[0]!;
  expect(await first.complete(appliedTransition)).toBe(true);
  await roomsRepository.transitionPhaseWithProjection(roomId, 4, { phase: "waiting", firstBattleAt: null, closedAt: null }); // unknown-commit retry
  expect((await client.db.select().from(rooms).where(eq(rooms.id, roomId)))[0]).toMatchObject({ status: "waiting", appliedProjectionRevision: 4 });
  await expect(roomsRepository.closeWithProjection(roomId, new Date("2026-08-29T02:30:00Z"), 3, { phase: "closed", firstBattleAt: null, closedAt: "2026-08-29T02:30:00.000Z" })).rejects.toThrow("ROOM_CLOSE_REVISION_CONFLICT");
  expect((await client.db.select().from(roomParticipants).where(eq(roomParticipants.roomId, roomId)))[0]?.leftAt).toBeNull();
  await first.enqueue({ roomId, revision: 5, payload: { phase: "waiting", firstBattleAt: null, closedAt: null } });
  await expect(first.enqueue({ roomId, revision: 5, payload: { phase: "battle", firstBattleAt: null, closedAt: null } })).rejects.toThrow("ROOM_PROJECTION_CONFLICT");
  const staleLease = (await first.claimDue(1, new Date("2099-01-02")))[0]!;
  const takeover = (await second.claimDue(1, new Date("2099-01-03")))[0]!;
  expect(await first.complete(staleLease)).toBe(false);
  expect(await first.fail(staleLease, "STALE", new Date("2099-01-03"))).toBe(false);
  expect(await second.complete(takeover)).toBe(true);
  const [closeRace, joinRace] = await Promise.allSettled([
    roomsRepository.closeWithProjection(roomId, new Date("2026-08-29T03:00:00Z"), 6, { phase: "closed", firstBattleAt: null, closedAt: "2026-08-29T03:00:00.000Z" }),
    roomsRepository.join(roomId, { participantPublicId: "racing-spectator", identityId: null, displayName: "Racer", role: "spectator", isOwner: false, ip: null, userAgent: null, deviceName: null }, new Date("2026-08-29T02:59:59Z")),
  ]);
  expect(closeRace.status).toBe("fulfilled");
  expect(["fulfilled", "rejected"]).toContain(joinRace.status);
  expect(await roomsRepository.applyProjection(roomId, 4, { phase: "waiting", firstBattleAt: null, closedAt: null })).toBe(false);
  expect((await client.db.select().from(rooms).where(eq(rooms.id, roomId)))[0]).toMatchObject({ status: "closed", appliedProjectionRevision: 6 });
  expect((await client.db.select().from(roomParticipants).where(eq(roomParticipants.roomId, roomId))).every((participant) => participant.leftAt !== null)).toBe(true);
  const [closedJob] = await first.claimDue(1, new Date("2099-01-04")); expect(closedJob).toBeDefined(); await first.complete(closedJob!);
  const prepared = await first.prepare({ roomId, revision: 7, payload: { phase: "result", firstBattleAt: null, closedAt: null } });
  expect(await second.claimDue(1, new Date("2099-01-05"))).toHaveLength(0);
  expect(await first.abortPrepared(prepared)).toBe(true);
  const replacement = await second.prepare({ roomId, revision: 7, payload: { phase: "waiting", firstBattleAt: null, closedAt: null } });
  expect(await first.commitPrepared(prepared)).toBe(false); expect(await second.commitPrepared(replacement)).toBe(true);
}, 30_000);

afterAll(async () => {
  if (!client) return;
  await client.sql.unsafe("set search_path to public");
  await client.sql.unsafe(`drop schema ${schemaName} cascade`);
  await client.close();
});

it.skipIf(!databaseUrl)("uses one cross-process claim and survives repository restart", async () => {
  const first = new PostgresBattleResultRepository(client.db, { pollMs: 5, maxWaitMs: 2_000 });
  const second = new PostgresBattleResultRepository(client.db, { pollMs: 5, maxWaitMs: 2_000 });
  const key = "36:00000000-0000-4000-8000-0000000000017:round-1";
  const fingerprint = "a".repeat(64);
  const acquired = await first.claim(key, fingerprint);
  if (!("status" in acquired)) throw new Error("claim was not acquired");
  const waiting = second.claim(key, fingerprint);
  const design = makeDefaultDesign();
  const result = simulateMatchRound(design, design, { seed: 7, launchA: { grade: "Great", angularMultiplier: 1, impulseMultiplier: 1 }, launchB: { grade: "Great", angularMultiplier: 1, impulseMultiplier: 1 } });
  await first.saveClaimed(acquired.handle, { fingerprint, result });
  await expect(waiting).resolves.toEqual({ fingerprint, result });
  await expect(new PostgresBattleResultRepository(client.db).get(key)).resolves.toEqual({ fingerprint, result });
}, 30_000);

it.skipIf(!databaseUrl)("recovers an abandoned expired simulation lease", async () => {
  const first = new PostgresBattleResultRepository(client.db, { leaseMs: 10 });
  const second = new PostgresBattleResultRepository(client.db, { leaseMs: 10, pollMs: 5, maxWaitMs: 1_000 });
  const key = "36:00000000-0000-4000-8000-0000000000027:round-1";
  const stale = await first.claim(key, "b".repeat(64));
  if (!("status" in stale)) throw new Error("claim was not acquired");
  await new Promise((resolve) => setTimeout(resolve, 15));
  const replacement = await second.claim(key, "b".repeat(64));
  if (!("status" in replacement)) throw new Error("replacement claim was not acquired");
  expect(await first.renewLease(stale.handle)).toBe(false);
});

it.skipIf(!databaseUrl)("atomically reuses a canonical owned design and reads it after restart", async () => {
  const identityId = randomUUID();
  await client.db.insert(identities).values({ id: identityId, status: "guest", displayName: "Design owner" });
  const design = makeDefaultDesign();
  const [left, right] = await Promise.all([
    new PostgresDesignRepository(client.db).saveBattleEligible(identityId, design),
    new PostgresDesignRepository(client.db).saveBattleEligible(identityId, { ...design, name: ` ${design.name} ` }),
  ]);
  expect(right.designId).toBe(left.designId);
  await expect(new PostgresDesignRepository(client.db).getOwned(identityId, left.designId)).resolves.toMatchObject({ designId: left.designId, design: { layers: [{ position: "top" }, { position: "middle" }, { position: "bottom" }] } });
  await expect(new PostgresDesignRepository(client.db).getOwned(randomUUID(), left.designId)).resolves.toBeUndefined();
});

it.skipIf(!databaseUrl)("persists an exact authoritative round set and rejects a composite collision", async () => {
  const player1IdentityId = randomUUID(); const player2IdentityId = randomUUID();
  await client.db.insert(identities).values([
    { id: player1IdentityId, status: "guest", displayName: "Player 1" },
    { id: player2IdentityId, status: "guest", displayName: "Player 2" },
  ]);
  const designs = new PostgresDesignRepository(client.db);
  const player1Design = await designs.saveBattleEligible(player1IdentityId, makeDefaultDesign());
  const player2Design = await designs.saveBattleEligible(player2IdentityId, makeDefaultDesign());
  const matchId = randomUUID(); const startedAt = new Date("2026-08-29T00:00:00Z");
  const repository = new PostgresMatchRepository(client.db);
  await repository.beginMatch({ id: matchId, roomId: null, player1IdentityId, player2IdentityId, player1DesignId: player1Design.designId, player2DesignId: player2Design.designId, performanceModelVersion: player1Design.performance.modelVersion, physicsModelVersion: "2.0.0", protocolVersion: 1, spectatorCount: 0, startedAt });
  const makeRound = (roundNumber: number): CompletedMatchRecord["rounds"][number] => ({
    id: randomUUID(), externalRoundId: `pg-round-${roundNumber}-${randomUUID()}`, roundNumber, attempt: 1, inputFingerprint: "a".repeat(64),
    launchA: { grade: "Great" as const, angularMultiplier: 1, impulseMultiplier: 1, tapReceivedAtMs: null, tapOffsetMs: null },
    launchB: { grade: "Good" as const, angularMultiplier: .9, impulseMultiplier: .9, tapReceivedAtMs: null, tapOffsetMs: null },
    startedAt, completedAt: new Date(startedAt.getTime() + roundNumber * 1_000),
    battleResult: { modelVersion: "2.0.0", seed: roundNumber, ticks: 60, frames: roundNumber === 1 ? Array.from({ length: 9_000 }, (_, tick) => ({ tick, player1: { x: tick / 100, y: 0, angle: tick / 10, angularSpeed: 10 }, player2: { x: -tick / 100, y: 0, angle: -tick / 10, angularSpeed: 9 } })) : [], outcome: { winner: "player1" as const, reason: "stopped" as const }, finalStats: { player1: { angularSpeed: 1, speedMps: 0, energyJ: 1, stoppedTicks: 0, impactRetentionProduct: 1 }, player2: { angularSpeed: 1, speedMps: 0, energyJ: 1, stoppedTicks: 0, impactRetentionProduct: 1 }, topTopContactCount: 0, topTopBeginContactEpisodes: 0, topTopImpactApplications: 0 } },
  });
  const authoritativeRounds = [makeRound(1), makeRound(2)];
  expect(Buffer.byteLength(JSON.stringify(authoritativeRounds[0]!.battleResult), "utf8")).toBeGreaterThan(1_000_000);
  expect(Buffer.byteLength(JSON.stringify(authoritativeRounds[0]!.battleResult), "utf8")).toBeLessThan(2_097_152);
  for (const round of authoritativeRounds) await repository.saveRoundAttempt(matchId, round);
  await expect(repository.saveRoundAttempt(matchId, { ...authoritativeRounds[0]!, battleResult: { ...authoritativeRounds[0]!.battleResult, ticks: 61 } })).rejects.toBeInstanceOf(MatchPersistenceConflictError);
  const base = {
    id: matchId, roomId: null,
    player1: { identityId: player1IdentityId, identitySource: "guest" as const, deviceName: null, ip: null, userAgent: null, designId: player1Design.designId, massG: player1Design.massG, score: { battlePoints: 2, challengePoints: 0, total: 2 } },
    player2: { identityId: player2IdentityId, identitySource: "guest" as const, deviceName: null, ip: null, userAgent: null, designId: player2Design.designId, massG: player2Design.massG, score: { battlePoints: 0, challengePoints: 0, total: 0 } },
    roundWinners: ["player1", "player1"] as Array<"player1" | "player2">, rounds: authoritativeRounds,
    performanceModelVersion: player1Design.performance.modelVersion, physicsModelVersion: "2.0.0", protocolVersion: 1, spectatorCount: 0,
    startedAt, completedAt: new Date(startedAt.getTime() + 3_000),
  };
  const completed = { ...base, idempotencyFingerprint: completedMatchFingerprint(base) } as CompletedMatchRecord;
  const extra = makeRound(3);
  await repository.saveRoundAttempt(matchId, extra);
  await expect(repository.saveCompletedMatch(completed)).rejects.toBeInstanceOf(MatchPersistenceConflictError);
  const [unchanged] = await client.db.select().from(matches).where(eq(matches.id, matchId));
  expect(unchanged).toMatchObject({ status: "in_progress", completedAt: null, player1BattlePoints: null, player1Total: null, persistFailureCode: null });
  expect(await client.db.select().from(rounds).where(eq(rounds.matchId, matchId))).toHaveLength(3);
  await client.db.delete(rounds).where(eq(rounds.id, extra.id));
  await expect(repository.queueCompletion(completed)).resolves.toBe("created");
  const restarted = new PostgresMatchRepository(client.db);
  const [leftClaims, rightClaims] = await Promise.all([repository.claimDueJobs(new Date("2099-01-01"), 1), restarted.claimDueJobs(new Date("2099-01-01"), 1)]);
  expect(leftClaims.length + rightClaims.length).toBe(1);
  const claim = [...leftClaims, ...rightClaims][0]!;
  const [takeover] = await restarted.claimDueJobs(new Date("2099-01-02"), 1);
  expect(takeover).toBeDefined();
  await expect(repository.retryFailedMatch(matchId, { claimToken: claim.claimToken, generation: claim.generation })).rejects.toBeInstanceOf(MatchPersistenceConflictError);
  await expect(repository.retryFailedMatch(matchId, { claimToken: takeover!.claimToken, generation: takeover!.generation })).resolves.toBe("created");
  await expect(new PostgresMatchRepository(client.db).retryFailedMatch(matchId)).resolves.toBe("replayed");
  await expect(repository.saveCompletedMatch(completed)).resolves.toBe("replayed");
  expect(await repository.pruneRetention(new Date("9999-01-01"), 10)).toBe(1);
  expect(await repository.getRetryJob(matchId)).toBeUndefined();
}, 30_000);
