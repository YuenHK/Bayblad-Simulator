import { describe, expect, it } from "vitest";
import { MemoryRoomProjectionStore } from "./room-projection-store";
import { MemoryRoomRecordRepository } from "./room-repository";

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
});
