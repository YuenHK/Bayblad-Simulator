import { describe, expect, it } from "vitest";
import { roomDeltaEventSchema, roomSnapshotEventSchema } from "@steam-top/protocol";
import { RoomService, RoomServiceError } from "./room-service";

const DESIGN_A = "7d9e2c75-2ef5-4ea7-aac2-18f385c1f82a";
const DESIGN_B = "15f60ed1-2a31-46ba-b3b4-da333921bf03";

const makeHarness = () => {
  let now = 1_000;
  let roomSequence = 0;
  let participantSequence = 0;
  let eventSequence = 0;
  const codes = ["SAME", "SAME", "NEXT", "THIRD"];
  const service = new RoomService({
    now: () => now,
    createRoomId: () => `room-${++roomSequence}`,
    createParticipantId: () => `p${++participantSequence}`,
    createRoomCode: () => codes.shift() ?? `C${roomSequence}`,
    createServerEventId: () =>
      `00000000-0000-4000-8000-${String(++eventSequence).padStart(12, "0")}`,
  });
  return {
    service,
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
  };
};

const user = (id: string, displayName = id) => ({ id, displayName });

describe("RoomService membership and public state", () => {
  it("creates a normalized room with its owner in player 1 and unique codes", () => {
    const { service } = makeHarness();
    const first = service.create(user("internal-owner", "  Cafe\u0301 🌟  "), "  First  ");
    const second = service.create(user("internal-other"), "Second");

    expect(first).toMatchObject({ roomId: "room-1", participantId: "p1", code: "SAME" });
    expect(second.code).toBe("NEXT");
    const snapshot = service.snapshot(first.roomId, "internal-owner");
    expect(roomSnapshotEventSchema.parse(snapshot)).toEqual(snapshot);
    expect(snapshot).toMatchObject({
      name: "First",
      revision: 1,
      ownerParticipantId: "p1",
      phase: "waiting",
      player1: { participantId: "p1", displayName: "Café 🌟", ready: false, designId: null },
      player2: null,
      spectators: [],
      viewer: { participantId: "p1", role: "player1", isOwner: true },
    });
    expect(JSON.stringify(snapshot)).not.toContain("internal-owner");
  });

  it("fills two seats, rejects a full player join, and supports 500 ordered spectators", () => {
    const { service } = makeHarness();
    const room = service.create(user("owner"), "Large room");
    service.join(room.roomId, user("player-2"), "player");
    expect(() => service.join(room.roomId, user("player-3"), "player")).toThrow(
      new RoomServiceError("ROOM_FULL"),
    );
    for (let index = 0; index < 500; index += 1) {
      service.join(room.roomId, user(`spectator-${index}`, `觀眾 ${index} 🌟`), "spectator");
    }
    const snapshot = service.snapshot(room.roomId, "spectator-499");
    expect(roomSnapshotEventSchema.parse(snapshot)).toEqual(snapshot);
    expect(snapshot.spectators).toHaveLength(500);
    expect(snapshot.spectators.map(({ displayName }) => displayName)).toEqual(
      Array.from({ length: 500 }, (_, index) => `觀眾 ${index} 🌟`),
    );
    expect(new TextEncoder().encode(JSON.stringify(snapshot)).byteLength).toBeLessThan(40_000);
  });

  it("makes repeated joins idempotent and never gives one user multiple roles", () => {
    const { service } = makeHarness();
    const room = service.create(user("owner"), "Room");
    const joined = service.join(room.roomId, user("viewer", "Viewer"), "spectator");
    const repeated = service.join(room.roomId, user("viewer", "Changed"), "player");
    expect(repeated).toEqual(joined);
    expect(service.snapshot(room.roomId, "viewer").viewer.role).toBe("spectator");
    expect(service.drainDeltas(room.roomId)).toHaveLength(1);
  });

  it("rejects unsafe display names using the protocol contract", () => {
    const { service } = makeHarness();
    expect(() => service.create(user("owner", "unsafe\u202ename"), "Room")).toThrow();
  });

  it("returns safe copies and refuses snapshots for non-members", () => {
    const { service } = makeHarness();
    const room = service.create(user("owner"), "Room");
    const snapshot = service.snapshot(room.roomId, "owner");
    if (!snapshot.player1) throw new Error("Expected player 1");
    snapshot.player1.displayName = "corrupt";
    snapshot.spectators.push({ participantId: "fake", displayName: "Fake" });
    expect(service.snapshot(room.roomId, "owner").player1?.displayName).toBe("owner");
    expect(() => service.snapshot(room.roomId, "outsider")).toThrow(
      new RoomServiceError("NOT_IN_ROOM"),
    );
  });

  it("returns a public readonly deep copy without internal identities", () => {
    const { service } = makeHarness();
    const room = service.create(user("internal-owner", "Owner"), "Original");
    service.join(room.roomId, user("internal-player", "Player"), "player");
    service.join(room.roomId, user("internal-spectator", "Spectator"), "spectator");

    const view = service.get(room.roomId);
    expect(view).toMatchObject({
      id: room.roomId,
      code: room.code,
      name: "Original",
      ownerParticipantId: room.participantId,
      phase: "waiting",
      revision: 3,
      emptySinceMs: null,
      player1: { participantId: room.participantId, displayName: "Owner" },
      player2: { displayName: "Player" },
      spectators: [{ displayName: "Spectator" }],
    });
    expect(JSON.stringify(view)).not.toContain("internal-");
    expect(JSON.stringify(view)).not.toContain("pendingDeltas");
    expect(JSON.stringify(view)).not.toContain("participants");

    const forced = view as unknown as {
      name: string;
      player1: { displayName: string };
      spectators: Array<{ displayName: string }>;
    };
    forced.name = "Corrupt";
    forced.player1.displayName = "Corrupt";
    forced.spectators[0]!.displayName = "Corrupt";
    forced.spectators.push({ displayName: "Injected" });

    expect(service.get(room.roomId)).toMatchObject({
      name: "Original",
      player1: { displayName: "Owner" },
      spectators: [{ displayName: "Spectator" }],
    });
    expect(service.snapshot(room.roomId, "internal-owner")).toMatchObject({
      name: "Original",
      player1: { displayName: "Owner" },
      spectators: [{ displayName: "Spectator" }],
    });
    expect(service.get("missing-room")).toBeUndefined();
  });
});

describe("RoomService moves, readiness, and phases", () => {
  it("keeps ownership when the creator moves to spectator and emits one atomic delta", () => {
    const { service } = makeHarness();
    const room = service.create(user("owner"), "Room");
    const spectator = service.join(room.roomId, user("spectator"), "spectator");
    service.drainDeltas(room.roomId);
    service.move(room.roomId, "owner", "spectator");
    const snapshot = service.snapshot(room.roomId, "owner");
    expect(snapshot.ownerParticipantId).toBe(room.participantId);
    expect(snapshot.viewer).toEqual({ participantId: room.participantId, role: "spectator", isOwner: true });
    expect(snapshot.player1).toBeNull();
    const [delta] = service.drainDeltas(room.roomId);
    expect(roomDeltaEventSchema.parse(delta)).toEqual(delta);
    expect(delta).toMatchObject({
      baseRevision: 2,
      revision: 3,
      patch: { player1: null, spectatorCount: 2 },
      joined: [{ participantId: room.participantId, displayName: "owner" }],
      leftParticipantIds: [],
    });
    expect(delta?.joined.some(({ participantId }) => participantId === spectator.participantId)).toBe(false);
  });

  it("keeps spectator order exactly reconstructable from an atomic move delta", () => {
    const { service, advance } = makeHarness();
    const room = service.create(user("owner", "First"), "Room");
    advance(1);
    service.join(room.roomId, user("spectator", "Second"), "spectator");
    const before = service.snapshot(room.roomId, "owner");
    service.drainDeltas(room.roomId);
    service.move(room.roomId, "owner", "spectator");
    const [delta] = service.drainDeltas(room.roomId);
    if (!delta) throw new Error("Expected move delta");
    const reconstructed = [
      ...before.spectators.filter(
        ({ participantId }) => !delta.leftParticipantIds.includes(participantId),
      ),
      ...delta.joined,
    ];
    expect(reconstructed).toEqual(service.snapshot(room.roomId, "owner").spectators);
    expect(reconstructed.map(({ displayName }) => displayName)).toEqual(["Second", "First"]);
  });

  it("lets only the owner move another participant and rejects occupied targets", () => {
    const { service } = makeHarness();
    const room = service.create(user("owner"), "Room");
    const player2 = service.join(room.roomId, user("player2"), "player");
    const spectator = service.join(room.roomId, user("spectator"), "spectator");
    expect(() => service.move(room.roomId, "player2", "player1", spectator.participantId)).toThrow(
      new RoomServiceError("OWNER_REQUIRED"),
    );
    expect(() => service.move(room.roomId, "owner", "player2", spectator.participantId)).toThrow(
      new RoomServiceError("SEAT_OCCUPIED"),
    );
    service.move(room.roomId, "owner", "spectator", player2.participantId);
    service.move(room.roomId, "owner", "player2", spectator.participantId);
    expect(service.snapshot(room.roomId, "spectator").viewer.role).toBe("player2");
  });

  it("accepts UUID designs only for seated players and can reset readiness", () => {
    const { service } = makeHarness();
    const room = service.create(user("owner"), "Room");
    service.join(room.roomId, user("player2"), "player");
    service.join(room.roomId, user("spectator"), "spectator");
    expect(() => service.ready(room.roomId, "spectator", DESIGN_A)).toThrow(
      new RoomServiceError("PLAYER_REQUIRED"),
    );
    expect(() => service.ready(room.roomId, "owner", "not-a-uuid")).toThrow();
    service.ready(room.roomId, "owner", DESIGN_A);
    service.ready(room.roomId, "player2", DESIGN_B);
    expect(service.snapshot(room.roomId, "owner")).toMatchObject({
      player1: { ready: true, designId: DESIGN_A },
      player2: { ready: true, designId: DESIGN_B },
      phase: "waiting",
    });
    service.resetReady(room.roomId, "owner");
    expect(service.snapshot(room.roomId, "owner").player1).toMatchObject({ ready: false, designId: null });
  });

  it("enforces phase transitions, seat locks, and waiting readiness reset", () => {
    const { service } = makeHarness();
    const room = service.create(user("owner"), "Room");
    service.join(room.roomId, user("player2"), "player");
    service.ready(room.roomId, "owner", DESIGN_A);
    service.setPhase(room.roomId, "launch");
    expect(() => service.move(room.roomId, "owner", "spectator")).toThrow(
      new RoomServiceError("SEATS_LOCKED"),
    );
    expect(() => service.setPhase(room.roomId, "result")).toThrow(
      new RoomServiceError("INVALID_PHASE_TRANSITION"),
    );
    service.setPhase(room.roomId, "battle");
    service.setPhase(room.roomId, "result");
    service.move(room.roomId, "player2", "spectator");
    service.setPhase(room.roomId, "waiting");
    expect(service.snapshot(room.roomId, "owner").player1).toMatchObject({ ready: false, designId: null });
  });
});

describe("RoomService disconnect, leave, sweep, and close", () => {
  it("restores the same participant before timeout and does not transfer owner at 119999ms", () => {
    const { service, advance } = makeHarness();
    const room = service.create(user("owner"), "Room");
    service.join(room.roomId, user("other"), "spectator");
    service.disconnect(room.roomId, "owner");
    advance(119_999);
    service.sweep();
    expect(service.snapshot(room.roomId, "other").ownerParticipantId).toBe(room.participantId);
    const restored = service.join(room.roomId, user("owner", "owner"), "player");
    expect(restored.participantId).toBe(room.participantId);
    expect(service.snapshot(room.roomId, "owner").viewer).toMatchObject({ role: "player1", isOwner: true });
  });

  it("treats a reconnect at the 120000ms boundary as a new participant without requiring sweep", () => {
    const { service, advance } = makeHarness();
    const room = service.create(user("owner"), "Room");
    const other = service.join(room.roomId, user("other"), "spectator");
    service.disconnect(room.roomId, "owner");
    advance(120_000);
    const rejoined = service.join(room.roomId, user("owner"), "player");
    expect(rejoined.participantId).not.toBe(room.participantId);
    const snapshot = service.snapshot(room.roomId, "owner");
    expect(snapshot.viewer.role).toBe("player1");
    expect(snapshot.ownerParticipantId).toBe(other.participantId);
  });

  it("transfers a timed-out owner at the 120000ms boundary and deletes an empty room", () => {
    const { service, advance } = makeHarness();
    const room = service.create(user("owner"), "Room");
    const other = service.join(room.roomId, user("other"), "spectator");
    service.disconnect(room.roomId, "owner");
    advance(120_000);
    service.sweep();
    expect(service.snapshot(room.roomId, "other").ownerParticipantId).toBe(other.participantId);

    service.disconnect(room.roomId, "other");
    advance(120_000);
    service.sweep();
    expect(service.hasRoom(room.roomId)).toBe(false);
  });

  it("transfers explicit ownership to the longest-connected participant with stable ties", () => {
    const { service } = makeHarness();
    const room = service.create(user("owner"), "Room");
    const first = service.join(room.roomId, user("z-user"), "spectator");
    const second = service.join(room.roomId, user("a-user"), "spectator");
    expect(first.participantId < second.participantId).toBe(true);
    service.drainDeltas(room.roomId);
    service.leave(room.roomId, "owner");
    expect(service.get(room.roomId)?.ownerParticipantId).toBe(first.participantId);
    expect(service.drainDeltas(room.roomId)).toMatchObject([
      {
        patch: { player1: null, ownerParticipantId: first.participantId },
      },
    ]);
  });

  it("starts empty retention after explicit final leave and counts connected spectators as nonempty", () => {
    const { service, advance } = makeHarness();
    const room = service.create(user("owner"), "Room");
    service.join(room.roomId, user("spectator"), "spectator");
    service.leave(room.roomId, "owner");
    advance(120_001);
    service.sweep();
    expect(service.hasRoom(room.roomId)).toBe(true);
    service.leave(room.roomId, "spectator");
    advance(119_999);
    service.sweep();
    expect(service.hasRoom(room.roomId)).toBe(true);
    advance(1);
    service.sweep();
    expect(service.hasRoom(room.roomId)).toBe(false);
  });

  it("makes the first new participant owner when joining a retained empty room", () => {
    const { service } = makeHarness();
    const room = service.create(user("owner"), "Room");
    service.leave(room.roomId, "owner");
    const newcomer = service.join(room.roomId, user("newcomer"), "spectator");
    expect(service.snapshot(room.roomId, "newcomer")).toMatchObject({
      ownerParticipantId: newcomer.participantId,
      viewer: { participantId: newcomer.participantId, role: "spectator", isOwner: true },
    });
  });

  it("allows only the owner to close waiting/result rooms", () => {
    const { service } = makeHarness();
    const room = service.create(user("owner"), "Room");
    service.join(room.roomId, user("other"), "spectator");
    expect(() => service.close(room.roomId, "other")).toThrow(new RoomServiceError("OWNER_REQUIRED"));
    service.setPhase(room.roomId, "launch");
    expect(() => service.close(room.roomId, "owner")).toThrow(new RoomServiceError("ROOM_ACTIVE"));
    service.setPhase(room.roomId, "battle");
    service.setPhase(room.roomId, "result");
    service.close(room.roomId, "owner");
    expect(service.hasRoom(room.roomId)).toBe(false);
  });
});

describe("RoomService deltas and lobby", () => {
  it("queues protocol-valid sequential deltas but never snapshots", () => {
    const { service } = makeHarness();
    const room = service.create(user("owner"), "Room");
    service.join(room.roomId, user("spectator"), "spectator");
    service.move(room.roomId, "spectator", "player2");
    const deltas = service.drainDeltas(room.roomId);
    expect(deltas).toHaveLength(2);
    expect(deltas.map(({ baseRevision, revision }) => [baseRevision, revision])).toEqual([
      [1, 2],
      [2, 3],
    ]);
    for (const delta of deltas) expect(roomDeltaEventSchema.parse(delta)).toEqual(delta);
    expect(deltas.some((event) => event.type === ("room.snapshot" as "room.delta"))).toBe(false);
  });

  it("exposes only names, seats, and counts in lobby snapshots", () => {
    const { service } = makeHarness();
    const room = service.create(user("internal-owner", "Owner"), "Public Room");
    service.join(room.roomId, user("internal-spectator", "Secret Person"), "spectator");
    const lobby = service.lobbySnapshot();
    expect(lobby.rooms).toEqual([
      {
        id: room.roomId,
        code: room.code,
        name: "Public Room",
        phase: "waiting",
        player1: { displayName: "Owner" },
        player2: { displayName: null },
        spectatorCount: 1,
      },
    ]);
    expect(JSON.stringify(lobby)).not.toContain("internal-");
    expect(JSON.stringify(lobby)).not.toContain("Secret Person");
  });
});
