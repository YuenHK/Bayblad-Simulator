import { describe, expect, it } from "vitest";
import { MemoryRoomProjectionStore } from "./room-projection-store";
import { MemoryRoomRecordRepository, PostgresRoomRecordRepository } from "./room-repository";

it("requires a bounded positive authority lock object id", () => {
  expect(() => new PostgresRoomRecordRepository(null as never, undefined, 0)).toThrow("INVALID_ROOM_AUTHORITY_LOCK_OBJECT_ID");
  expect(() => new PostgresRoomRecordRepository(null as never, undefined, 2)).not.toThrow();
});

it("takes over the dedicated authority lock from a rolling-deploy predecessor", async () => {
  const calls: string[] = [];
  const reserved = async (strings: TemplateStringsArray) => {
    const query = strings.join("?"); calls.push(query);
    if (query.includes("pg_try_advisory_lock")) return [{ acquired: false, backendPid: 202 }];
    if (query.includes("pg_advisory_lock")) return [{ backendPid: 202 }];
    if (query.includes("pg_terminate_backend")) return [{ terminated: true }];
    return [];
  };
  Object.assign(reserved, { release: () => undefined });
  const sql = Object.assign(async () => [], { reserve: async () => reserved });
  const repository = new PostgresRoomRecordRepository(null as never, sql as never, 1001);
  await repository.acquireStartupLease();
  expect(calls.filter((value) => value.includes("pg_try_advisory_lock"))).toHaveLength(1);
  expect(calls.some((value) => value.includes("select pg_advisory_lock"))).toBe(true);
  expect(calls.some((value) => value.includes("pg_terminate_backend") && value.includes("pg_locks"))).toBe(true);
  expect(repository.startupLeaseBackendPidForTesting).toBe(202);
});

const participant = { participantPublicId: "participant-1", identityId: null, displayName: "Student", role: "player1" as const, isOwner: true, ip: null, userAgent: null, deviceName: null };

describe("MemoryRoomRecordRepository authoritative transitions", () => {
  it("commits the projection before authority and supports exact unknown-response retry", async () => {
    const projections = new MemoryRoomProjectionStore(); const repository = new MemoryRoomRecordRepository(projections);
    await repository.create({ id: "room-1", code: "ABC123", name: "Room", ownerIdentityId: null, participant, at: new Date(0) });
    const payload = { phase: "launch" as const, firstBattleAt: null, closedAt: null };
    await repository.transitionPhaseWithProjection("room-1", 0, payload);
    await repository.transitionPhaseWithProjection("room-1", 0, payload);
    expect(repository.snapshot("room-1")).toMatchObject({ status: "launch", revision: 0 });
    expect(await projections.claimDue(10, new Date())).toHaveLength(1);
  });

  it("reconciles active rooms to closed authority and leaves participants", async () => {
    const projections = new MemoryRoomProjectionStore(); const repository = new MemoryRoomRecordRepository(projections);
    await repository.create({ id: "room-1", code: "ABC123", name: "Room", ownerIdentityId: null, participant, at: new Date(0) });
    expect(await repository.reconcileOrphanedActiveRooms(new Date(1_000))).toBe(1);
    const room = repository.snapshot("room-1")!;
    expect(room).toMatchObject({ status: "closed", revision: 0 });
    expect(room.participants.get("participant-1")?.leftAt).toEqual(new Date(1_000));
  });
  it("rolls back the memory outbox when authority commit fails", async () => {
    const projections = new MemoryRoomProjectionStore();
    const repository = new MemoryRoomRecordRepository(projections, { beforeAuthorityCommit: () => { throw new Error("authority failed"); } });
    await repository.create({ id: "room-1", code: "ABC123", name: "Room", ownerIdentityId: null, participant, at: new Date(0) });
    await expect(repository.transitionPhaseWithProjection("room-1", 0, { phase: "launch", firstBattleAt: null, closedAt: null })).rejects.toThrow("authority failed");
    expect(repository.snapshot("room-1")).toMatchObject({ status: "waiting", revision: -1 });
    expect(projections.size).toBe(0);
  });
  it("serializes cross-room memory transactions so rollback cannot erase another commit", async () => {
    const projections = new MemoryRoomProjectionStore(); let release!: () => void; let entered!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const staged = new Promise<void>((resolve) => { entered = resolve; });
    const first = projections.transaction(async () => { await projections.enqueue({ roomId: "room-1", revision: 0, payload: { phase: "launch", firstBattleAt: null, closedAt: null } }); entered(); await barrier; throw new Error("rollback"); });
    const second = projections.transaction(async () => projections.enqueue({ roomId: "room-2", revision: 0, payload: { phase: "launch", firstBattleAt: null, closedAt: null } }));
    await staged; let claimSettled = false; const claim = projections.claimDue(10, new Date("2099-01-01")).finally(() => { claimSettled = true; });
    await new Promise<void>((resolve) => setTimeout(resolve, 0)); expect(claimSettled).toBe(false);
    release(); await expect(first).rejects.toThrow("rollback"); await expect(second).resolves.toBe("created");
    const claimed = await claim;
    expect(claimed.map(({ roomId }) => roomId)).toEqual(["room-2"]);
  });
});
