import { makeDefaultDesign } from "@steam-top/domain";
import type { ServerEvent } from "@steam-top/protocol";
import { io, type Socket } from "socket.io-client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BattleInputs, BattleResult } from "./battle/engine";
import { buildApp, type BattleEnginePort } from "./app";
import { LaunchCoordinator } from "./battle/launch";
import { scoreMatch } from "./battle/scoring";
import { RoomService } from "./rooms/room-service";
import { DesignRegistry } from "./design-registry";
import { AdminAuthService, InMemoryAdminStore } from "./auth/admin-auth";
import { MemoryMatchRepository } from "./records/match-repository";
import type { RoomRecordRepository } from "./records/room-repository";
import { MemoryRoomProjectionStore } from "./records/room-projection-store";
import { shouldRecordRealtimeActivity } from "./socket";

const uuid = () => crypto.randomUUID();
const command = (type: string, fields: Record<string, unknown> = {}) => ({
  type,
  protocolVersion: 1,
  eventId: uuid(),
  ...fields,
});

class FakeBattleEngine implements BattleEnginePort {
  simulationCount = 0;
  outcomes: Array<"player1" | "player2" | "draw" | "throw"> = ["player1", "player1"];
  frames: BattleResult["frames"] = [{
    tick: 1,
    player1: { x: -10, y: 0, angle: 0, angularSpeed: 10 },
    player2: { x: 10, y: 0, angle: 0, angularSpeed: 10 },
  }];
  async simulateOnceAsync(_matchId: string, _roundId: string, inputs: BattleInputs): Promise<BattleResult> {
    this.simulationCount += 1;
    const winner = this.outcomes.shift() ?? "player1";
    if (winner === "throw") throw new Error("injected physics failure");
    return {
      modelVersion: "2.0.0",
      seed: inputs.seed,
      ticks: this.frames.at(-1)?.tick ?? 0,
      frames: structuredClone(this.frames),
      outcome: { winner, reason: winner === "draw" ? "simultaneous" : "stopped" },
      finalStats: {
        player1: { angularSpeed: 10, speedMps: 0, energyJ: 1, stoppedTicks: 0, impactRetentionProduct: 1 },
        player2: { angularSpeed: 10, speedMps: 0, energyJ: 1, stoppedTicks: 0, impactRetentionProduct: 1 },
        topTopContactCount: 0,
        topTopBeginContactEpisodes: 0,
        topTopImpactApplications: 0,
      },
    };
  }
  cleanup(): boolean { return true; }
}

class FailFirstPhaseRoomService extends RoomService {
  #failed = false;
  override setPhase(roomId: string, phase: Parameters<RoomService["setPhase"]>[1]): void {
    super.setPhase(roomId, phase);
    if (!this.#failed && phase === "launch") { this.#failed = true; throw new Error("injected phase failure"); }
  }
}

class FailFirstScheduleCoordinator extends LaunchCoordinator {
  #failed = false;
  override schedule(input: Parameters<LaunchCoordinator["schedule"]>[0]): ReturnType<LaunchCoordinator["schedule"]> {
    const scheduled = super.schedule(input);
    if (!this.#failed) { this.#failed = true; throw new Error("injected schedule failure"); }
    return scheduled;
  }
}

class FailTwiceMatchRepository extends MemoryMatchRepository {
  saveCalls = 0;
  override async saveCompletedMatch(input: Parameters<MemoryMatchRepository["saveCompletedMatch"]>[0]) {
    this.saveCalls += 1;
    if (this.saveCalls <= 2) throw new Error("injected persistence failure");
    return super.saveCompletedMatch(input);
  }
}

class FailWaitingRoomProjection implements RoomRecordRepository {
  waitingFailures = 0;
  reconcileOrphanedActiveRooms: NonNullable<RoomRecordRepository["reconcileOrphanedActiveRooms"]> = async () => 0;
  async create() {} async join() {} async recordBattleStart() {} async updateOwner() {} async syncRoles() {} async leave() {} async leaveAndSync() {} async close() {}
  async updatePhase(_roomId: string, phase: "waiting" | "launch" | "battle" | "result") {
    if (phase === "waiting") { this.waitingFailures += 1; throw new Error("injected room projection failure"); }
  }
}

class DelayedCreateRoomProjection implements RoomRecordRepository {
  createCalls = 0;
  releaseCreate!: () => void;
  #started!: () => void;
  readonly createStarted = new Promise<void>((resolve) => { this.#started = resolve; });
  async create() { this.createCalls++; this.#started(); await new Promise<void>((resolve) => { this.releaseCreate = resolve; }); }
  async join() {} async recordBattleStart() {} async updateOwner() {} async syncRoles() {} async leave() {} async leaveAndSync() {} async close() {} async updatePhase() {}
}
class FailFirstCreateRoomProjection extends FailWaitingRoomProjection {
  createCalls = 0; release!: () => void; #started!: () => void;
  readonly started = new Promise<void>((resolve) => { this.#started = resolve; });
  override async create() { this.createCalls += 1; if (this.createCalls === 1) { this.#started(); await new Promise<void>((resolve) => { this.release = resolve; }); throw new Error("offline"); } }
}
class RejectingClaimProjectionStore extends MemoryRoomProjectionStore {
  reject!: (error: Error) => void; started!: () => void;
  readonly claimStarted = new Promise<void>((resolve) => { this.started = resolve; });
  override async claimDue(): Promise<never> { this.started(); return new Promise<never>((_resolve, reject) => { this.reject = reject; }); }
}

function nextEvent(socket: Socket, type: ServerEvent["type"] | "protocol.unsupported", timeoutMs = 3_000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off("server.event", listener);
      reject(new Error(`Timed out waiting for ${type}`));
    }, timeoutMs);
    const listener = (event: ServerEvent) => {
      if (event.type !== type) return;
      clearTimeout(timeout);
      socket.off("server.event", listener);
      resolve(event);
    };
    socket.on("server.event", listener);
  });
}

async function connect(url: string, displayName: string, sessionToken?: string) {
  const socket = io(url, { transports: ["websocket"], auth: { displayName, ...(sessionToken ? { sessionToken } : {}) } });
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("connect_error", reject);
  });
  const welcomePromise = nextEvent(socket, "protocol.welcome");
  socket.emit("client.event", { type: "protocol.hello", eventId: uuid(), supportedVersions: [1] });
  const welcome = await welcomePromise;
  return { socket, token: welcome.sessionToken as string };
}

describe("realtime app", () => {
  it("throttles a thousand heartbeat pings but records immediately across HK midnight",()=>{
    const start=Date.parse("2026-08-31T15:59:59Z");let recorded=start,count=0;
    for(let index=1;index<=1_000;index++){const at=start+index*100;if(shouldRecordRealtimeActivity(recorded,at)){recorded=at;count++;}}
    expect(count).toBe(1);
    expect(shouldRecordRealtimeActivity(Date.parse("2026-08-30T15:59:59Z"),Date.parse("2026-08-30T16:00:00Z"))).toBe(true);
  });
  const closers: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    for (const close of closers.splice(0).reverse()) await close();
    vi.unstubAllEnvs();
  });

  it("reconciles orphaned durable rooms before accepting traffic", async () => {
    let reconciled = false;
    const repository = new FailWaitingRoomProjection();
    repository.reconcileOrphanedActiveRooms = async () => { reconciled = true; return 1; };
    const app = buildApp({ battleEngine: new FakeBattleEngine(), roomRecordRepository: repository, sweepIntervalMs: 0 });
    closers.push(() => app.close());
    await app.ready();
    expect(reconciled).toBe(true);
  });

  it("fails startup when orphan reconciliation fails", async () => {
    const repository = new FailWaitingRoomProjection();
    repository.reconcileOrphanedActiveRooms = async () => { throw new Error("database unavailable"); };
    const app = buildApp({ battleEngine: new FakeBattleEngine(), roomRecordRepository: repository, sweepIntervalMs: 0 });
    closers.push(() => app.close());
    await expect(app.ready()).rejects.toThrow("database unavailable");
  });

  it("clears terminal recovery callbacks during gateway close", async () => {
    const rooms = new RoomService(); const room = rooms.create({ id: "owner", displayName: "Owner" }, "Timer");
    const app = buildApp({ battleEngine: new FakeBattleEngine(), rooms, sweepIntervalMs: 0 }); closers.push(() => app.close());
    app.realtimeGateway.scheduleTerminalRecoveryForTesting(room.roomId);
    expect(app.realtimeGateway.debugCounts.terminalRecoveryTimers).toBe(1);
    const revision = rooms.get(room.roomId)!.revision; await app.close();
    expect(app.realtimeGateway.debugCounts.terminalRecoveryTimers).toBe(0);
    await new Promise<void>((resolve) => setTimeout(resolve, 1_050));
    expect(rooms.get(room.roomId)?.revision).toBe(revision);
  });
  it("stops transport and clears state even when projection shutdown rejects", async () => {
    const store = new RejectingClaimProjectionStore(); const repository = new FailWaitingRoomProjection();
    const app = buildApp({ battleEngine: new FakeBattleEngine(), roomRecordRepository: repository, roomProjectionStore: store, sweepIntervalMs: 0 });
    const pumping = app.realtimeGateway.pump(); await store.claimStarted;
    const closing = app.realtimeGateway.close(); store.reject(new Error("projection failed"));
    await expect(pumping).rejects.toThrow("projection failed");
    await expect(closing).rejects.toMatchObject({ definitivelyStopped: true });
    expect(app.realtimeGateway.definitivelyStopped).toBe(true);
    expect(app.realtimeGateway.debugCounts).toMatchObject({ sessions: 0, terminalRecoveryTimers: 0 });
  });

  it("serializes concurrent duplicate commands per session and shares their outcome", async () => {
    const roomProjection = new DelayedCreateRoomProjection();
    const app = buildApp({ battleEngine: new FakeBattleEngine(), roomRecordRepository: roomProjection, sweepIntervalMs: 0 });
    closers.push(() => app.close());
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("No address");
    const client = await connect(`http://127.0.0.1:${address.port}`, "Duplicate");
    closers.push(() => { client.socket.close(); });
    const createEvent = command("room.create", { name: "Only once" });
    const acknowledgements: any[] = [];
    client.socket.on("server.event", (event) => { if (event.type === "command.ack" && event.causedByEventId === createEvent.eventId) acknowledgements.push(event); });
    client.socket.emit("client.event", createEvent);
    await roomProjection.createStarted;
    client.socket.emit("client.event", createEvent);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(roomProjection.createCalls).toBe(1);
    roomProjection.releaseCreate();
    while (acknowledgements.length < 2) await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(acknowledgements.map(({ status }) => status)).toEqual(["applied", "replayed"]);
  });

  it("orders distinct commands across sockets and continues after the first command fails", async () => {
    const repository = new FailFirstCreateRoomProjection();
    const app = buildApp({ battleEngine: new FakeBattleEngine(), roomRecordRepository: repository, sweepIntervalMs: 0 });
    closers.push(() => app.close()); await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address(); if (!address || typeof address === "string") throw new Error("No address");
    const url = `http://127.0.0.1:${address.port}`; const first = await connect(url, "Shared"); const second = await connect(url, "Shared", first.token);
    closers.push(() => { first.socket.close(); }, () => { second.socket.close(); });
    const firstCommand = command("room.create", { name: "Fails" }); const secondCommand = command("room.create", { name: "Succeeds" });
    const failed = nextEvent(first.socket, "error"); first.socket.emit("client.event", firstCommand); await repository.started;
    const created = nextEvent(second.socket, "room.snapshot"); second.socket.emit("client.event", secondCommand); repository.release();
    expect(await failed).toMatchObject({ causedByEventId: firstCommand.eventId, code: "COMMAND_FAILED" });
    expect(await created).toMatchObject({ name: "Succeeds" }); expect(repository.createCalls).toBe(2);
  });

  it("可以用公開房間碼進入並真正離房，不會在重連時自動回到舊房", async () => {
    let now = 1_000;
    const app = buildApp({ battleEngine: new FakeBattleEngine(), now: () => now, sweepIntervalMs: 0 });
    closers.push(() => app.close());
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("No address");
    const url = `http://127.0.0.1:${address.port}`;
    const owner = await connect(url, "Owner");
    const peer = await connect(url, "Peer");
    closers.push(() => { owner.socket.close(); }, () => { peer.socket.close(); });
    const created = nextEvent(owner.socket, "room.snapshot");
    owner.socket.emit("client.event", command("room.create", { name: "Code room" }));
    const room = await created;
    const joined = nextEvent(peer.socket, "room.snapshot");
    const joinedDelta = nextEvent(owner.socket, "room.delta");
    peer.socket.emit("client.event", command("room.join", { roomId: room.code.toLowerCase(), role: "player" }));
    const peerRoom = await joined;
    await joinedDelta;
    expect(peerRoom.roomId).toBe(room.roomId);
    const left = nextEvent(owner.socket, "room.delta");
    const departed = nextEvent(peer.socket, "room.departed");
    peer.socket.emit("client.event", command("room.leave", { roomId: room.roomId }));
    expect(await left).toMatchObject({ patch: { player2: null } });
    const departure = await departed;
    expect(departure).toMatchObject({ roomId: room.roomId, reason: "left", departureId: expect.any(String) });
    peer.socket.close();
    const resumedSocket = io(url, { transports: ["websocket"], auth: { displayName: "Peer", sessionToken: peer.token } });
    await new Promise<void>((resolve) => resumedSocket.once("connect", resolve));
    const resumedWelcome = nextEvent(resumedSocket, "protocol.welcome");
    const replayedDeparture = nextEvent(resumedSocket, "room.departed");
    resumedSocket.emit("client.event", { type: "protocol.hello", eventId: uuid(), supportedVersions: [1] });
    expect((await resumedWelcome).sessionStatus).toBe("resumed");
    expect(await replayedDeparture).toEqual(departure);
    const departureAck = nextEvent(resumedSocket, "command.ack");
    resumedSocket.emit("client.event", command("room.departed.ack", { departureId: departure.departureId }));
    expect((await departureAck).status).toBe("applied");
    const duplicateAck = nextEvent(resumedSocket, "command.ack");
    resumedSocket.emit("client.event", command("room.departed.ack", { departureId: departure.departureId }));
    expect((await duplicateAck).status).toBe("applied");
    resumedSocket.close();
    const resumed = await connect(url, "Peer", peer.token);
    closers.push(() => { resumed.socket.close(); });
    const unexpected = vi.fn();
    resumed.socket.on("server.event", (event) => { if (event.type === "room.snapshot" || event.type === "room.departed") unexpected(event); });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(unexpected).not.toHaveBeenCalled();
    now += 120_001;
    await app.realtimeGateway.pump(now);
  });

  it("回應 clock.ping 四時間戳，並在房主關房時通知全部成員", async () => {
    let now = 6_025;const activity=vi.fn(async()=>undefined);
    const app = buildApp({ battleEngine: new FakeBattleEngine(), now: () => now, sweepIntervalMs: 0,testRecordIdentityActivity:activity });
    closers.push(() => app.close());
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("No address");
    const url = `http://127.0.0.1:${address.port}`;
    const owner = await connect(url, "Owner");
    const watcher = await connect(url, "Watcher");
    closers.push(() => { owner.socket.close(); }, () => { watcher.socket.close(); });
    const pong = nextEvent(owner.socket, "clock.pong");
    owner.socket.emit("client.event", command("clock.ping", { pingId: "ping-1", clientSentAtMs: 1_000 }));
    expect(await pong).toMatchObject({ pingId: "ping-1", clientSentAtMs: 1_000, serverReceiveTimeMs: 6_025, serverSendTimeMs: 6_025 });
    now = 6_065;
    const clockAck = nextEvent(owner.socket, "command.ack");
    owner.socket.emit("client.event", command("clock.ack", { pingId: "ping-1" }));
    expect((await clockAck).status).toBe("applied");
    const duplicateAck = nextEvent(owner.socket, "command.ack");
    owner.socket.emit("client.event", command("clock.ack", { pingId: "ping-1" }));
    expect((await duplicateAck).status).toBe("applied");
    const replayedPing = nextEvent(owner.socket, "error");
    owner.socket.emit("client.event", command("clock.ping", { pingId: "ping-1", clientSentAtMs: 9_999 }));
    expect((await replayedPing).code).toBe("CLOCK_PING_REPLAY");
    expect(activity).toHaveBeenCalledTimes(0);
    now+=300_001;const heartbeatPong=nextEvent(owner.socket,"clock.pong");owner.socket.emit("client.event",command("clock.ping",{pingId:"ping-2",clientSentAtMs:now}));await heartbeatPong;await vi.waitFor(()=>expect(activity).toHaveBeenCalledTimes(1));
    const unknownAck = nextEvent(owner.socket, "error");
    owner.socket.emit("client.event", command("clock.ack", { pingId: "never-issued" }));
    expect((await unknownAck).code).toBe("CLOCK_CHALLENGE_INVALID");
    const created = nextEvent(owner.socket, "room.snapshot");
    owner.socket.emit("client.event", command("room.create", { name: "Close room" }));
    const room = await created;
    const joined = nextEvent(watcher.socket, "room.snapshot");
    const delta = nextEvent(owner.socket, "room.delta");
    watcher.socket.emit("client.event", command("room.join", { roomId: room.roomId, role: "spectator" }));
    await Promise.all([joined, delta]);
    const ownerDeparted = nextEvent(owner.socket, "room.departed");
    const watcherDeparted = nextEvent(watcher.socket, "room.departed");
    owner.socket.emit("client.event", command("room.close", { roomId: room.roomId }));
    expect(await ownerDeparted).toMatchObject({ roomId: room.roomId, reason: "closed" });
    expect(await watcherDeparted).toMatchObject({ roomId: room.roomId, reason: "closed" });
    expect(app.realtimeGateway.debugCounts.pendingDepartures).toBe(2);
    now += 120_001;
    await app.realtimeGateway.pump(now);
    expect(app.realtimeGateway.debugCounts.pendingDepartures).toBe(0);
  });

  it("每個 session 同時只可加入一個房間，離房後才可加入新房", async () => {
    const app = buildApp({ battleEngine: new FakeBattleEngine(), sweepIntervalMs: 0 });
    closers.push(() => app.close());
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("No address");
    const url = `http://127.0.0.1:${address.port}`;
    const first = await connect(url, "First");
    const second = await connect(url, "Second");
    closers.push(() => { first.socket.close(); }, () => { second.socket.close(); });
    const firstCreated = nextEvent(first.socket, "room.snapshot");
    first.socket.emit("client.event", command("room.create", { name: "First room" }));
    const room1 = await firstCreated;
    const secondCreated = nextEvent(second.socket, "room.snapshot");
    second.socket.emit("client.event", command("room.create", { name: "Second room" }));
    const room2 = await secondCreated;
    const blocked = nextEvent(first.socket, "error");
    first.socket.emit("client.event", command("room.join", { roomId: room2.roomId, role: "spectator" }));
    expect((await blocked).code).toBe("ALREADY_IN_ROOM");
    const departed = nextEvent(first.socket, "room.departed");
    first.socket.emit("client.event", command("room.leave", { roomId: room1.roomId }));
    await departed;
    const joined = nextEvent(first.socket, "room.snapshot");
    first.socket.emit("client.event", command("room.join", { roomId: room2.roomId, role: "spectator" }));
    expect((await joined).roomId).toBe(room2.roomId);
  });

  it("延遲clock ACK不能把固定server收件時間的Good提升為Perfect", async () => {
    let now = 1_000;
    const app = buildApp({
      battleEngine: new FakeBattleEngine(), now: () => now,
      launch: new LaunchCoordinator({ now: () => now, leadTimeMs: 100 }), sweepIntervalMs: 0,
    });
    closers.push(() => app.close());
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("No address");
    const url = `http://127.0.0.1:${address.port}`;
    const p1 = await connect(url, "Latency P1");
    const p2 = await connect(url, "Latency P2");
    closers.push(() => { p1.socket.close(); }, () => { p2.socket.close(); });
    const pong = nextEvent(p1.socket, "clock.pong");
    p1.socket.emit("client.event", command("clock.ping", { pingId: "delayed-ack", clientSentAtMs: 1_000 }));
    await pong;
    const created = nextEvent(p1.socket, "room.snapshot");
    p1.socket.emit("client.event", command("room.create", { name: "Latency" }));
    const room = await created;
    const joined = nextEvent(p2.socket, "room.snapshot");
    p2.socket.emit("client.event", command("room.join", { roomId: room.roomId, role: "player" }));
    await joined;
    const register = async (token: string) => (await app.inject({
      method: "POST", url: "/api/designs", headers: { authorization: `Bearer ${token}` }, payload: makeDefaultDesign(),
    })).json().designId as string;
    const [d1, d2] = await Promise.all([register(p1.token), register(p2.token)]);
    p1.socket.emit("client.event", command("player.ready", { roomId: room.roomId, designId: d1 }));
    const scheduled = nextEvent(p1.socket, "launch.schedule");
    p2.socket.emit("client.event", command("player.ready", { roomId: room.roomId, designId: d2 }));
    const schedule = await scheduled;
    now = schedule.serverTargetTimeMs + 145;
    const ack = nextEvent(p1.socket, "command.ack");
    p1.socket.emit("client.event", command("clock.ack", { pingId: "delayed-ack" }));
    await ack;
    const grade = nextEvent(p1.socket, "launch.result.private");
    p1.socket.emit("client.event", command("launch.tap", {
      roomId: room.roomId, roundId: schedule.roundId, nonce: schedule.nonce, clientTimeMs: schedule.serverTargetTimeMs,
    }));
    expect((await grade).grade).toBe("Good");
  });

  it("allocates sessions only after hello, enforces handshake timeout, quotas, rate recovery, and payload limits", async () => {
    let now = 1_000;
    const app = buildApp({
      battleEngine: new FakeBattleEngine(), now: () => now, sweepIntervalMs: 0,
      handshakeTimeoutMs: 20, rateLimitBurst: 1, rateLimitRefillPerSecond: 1,
      maxOwnedRoomsPerSession: 1, maxRooms: 1, maxDesignsPerSession: 1,
      bodyLimit: 4_096, maxHttpBufferSize: 512,
    });
    closers.push(() => app.close());
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("No address");
    const url = `http://127.0.0.1:${address.port}`;

    const pending = io(url, { transports: ["websocket"], auth: { displayName: "Pending" } });
    await new Promise<void>((resolve) => pending.once("connect", resolve));
    expect(app.realtimeGateway.debugCounts.sessions).toBe(0);
    await new Promise<void>((resolve) => pending.once("disconnect", () => resolve()));
    expect(app.realtimeGateway.debugCounts).toMatchObject({ sessions: 0, connections: 0, newSessionClientBuckets: 0 });

    const owner = await connect(url, "Owner");
    closers.push(() => { owner.socket.close(); });
    const created = nextEvent(owner.socket, "room.snapshot");
    owner.socket.emit("client.event", command("room.create", { name: "Only room" }));
    await created;
    const rateLimited = nextEvent(owner.socket, "error");
    owner.socket.emit("client.event", command("room.create", { name: "Too fast" }));
    expect((await rateLimited).code).toBe("RATE_LIMITED");
    now += 1_000;
    const quota = nextEvent(owner.socket, "error");
    owner.socket.emit("client.event", command("room.create", { name: "Too many" }));
    expect((await quota).code).toBe("ALREADY_IN_ROOM");
    const other = await connect(url, "Other owner");
    closers.push(() => { other.socket.close(); });
    const full = nextEvent(other.socket, "error");
    other.socket.emit("client.event", command("room.create", { name: "Global full" }));
    expect((await full).code).toBe("SERVER_CAPACITY");

    expect((await app.inject({
      method: "POST", url: "/api/designs", headers: { authorization: `Bearer ${owner.token}` }, payload: makeDefaultDesign(),
    })).statusCode).toBe(201);
    expect((await app.inject({
      method: "POST", url: "/api/designs", headers: { authorization: `Bearer ${owner.token}` }, payload: makeDefaultDesign(),
    })).statusCode).toBe(429);
    expect((await app.inject({
      method: "POST", url: "/api/designs", headers: { authorization: `Bearer ${other.token}` }, payload: { padding: "x".repeat(8_192) },
    })).statusCode).toBe(413);

    const oversized = io(url, { transports: ["websocket"], auth: { displayName: "Oversized" } });
    closers.push(() => { oversized.close(); });
    await new Promise<void>((resolve) => oversized.once("connect", resolve));
    oversized.emit("client.event", { type: "protocol.hello", eventId: uuid(), supportedVersions: [1] });
    await nextEvent(oversized, "protocol.welcome");
    const disconnected = new Promise<void>((resolve) => oversized.once("disconnect", () => resolve()));
    oversized.emit("client.event", "x".repeat(2_048));
    await disconnected;
  });

  it("bounds retained session churn, rate-limits new identities, and reclaims them after retention", async () => {
    let now = 1_000;
    const app = buildApp({
      battleEngine: new FakeBattleEngine(), now: () => now, sweepIntervalMs: 0,
      maxRetainedSessions: 3, newSessionBurstPerClient: 2, newSessionRefillPerSecond: 1,
      newSessionGlobalBurst: 20, newSessionGlobalRefillPerSecond: 20,
    });
    closers.push(() => app.close());
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("No address");
    const url = `http://127.0.0.1:${address.port}`;
    for (let wave = 0; wave < 5; wave += 1) {
      const client = await connect(url, `Churn ${wave}`);
      client.socket.close();
      await new Promise<void>((resolve) => setTimeout(resolve, 2));
      expect(app.realtimeGateway.debugCounts.sessions).toBeLessThanOrEqual(3);
      now += 1_000;
    }
    const first = await connect(url, "Burst 1");
    const second = await connect(url, "Burst 2");
    closers.push(() => { first.socket.close(); }, () => { second.socket.close(); });
    const blocked = io(url, { transports: ["websocket"], reconnection: false, auth: { displayName: "Burst blocked" } });
    closers.push(() => { blocked.close(); });
    await new Promise<void>((resolve) => blocked.once("connect", resolve));
    const limited = nextEvent(blocked, "error");
    const blockedDisconnected = new Promise<void>((resolve) => blocked.once("disconnect", () => resolve()));
    blocked.emit("client.event", { type: "protocol.hello", eventId: uuid(), supportedVersions: [1] });
    expect((await limited).code).toBe("SESSION_RATE_LIMITED");
    await blockedDisconnected;
    first.socket.close(); second.socket.close();
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
    now += 120_001;
    await app.realtimeGateway.pump(now);
    expect(app.realtimeGateway.debugCounts).toMatchObject({ sessions: 0, connections: 0, newSessionClientBuckets: 0 });
  });

  it("responds once then disconnects unsupported and repeated hello spam", async () => {
    const app = buildApp({ battleEngine: new FakeBattleEngine(), sweepIntervalMs: 0 });
    closers.push(() => app.close());
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("No address");
    const url = `http://127.0.0.1:${address.port}`;
    const unsupported = io(url, { transports: ["websocket"], reconnection: false, auth: { displayName: "Unsupported" } });
    await new Promise<void>((resolve) => unsupported.once("connect", resolve));
    const unsupportedEvents: any[] = [];
    unsupported.on("server.event", (event) => unsupportedEvents.push(event));
    const unsupportedReply = nextEvent(unsupported, "protocol.unsupported");
    const unsupportedDisconnected = new Promise<void>((resolve) => unsupported.once("disconnect", () => resolve()));
    for (let index = 0; index < 100; index += 1) unsupported.emit("client.event", { type: "protocol.hello", eventId: uuid(), supportedVersions: [9] });
    await Promise.all([unsupportedReply, unsupportedDisconnected]);
    expect(unsupportedEvents.filter(({ type }) => type === "protocol.unsupported")).toHaveLength(1);

    const welcomed = await connect(url, "Welcomed");
    closers.push(() => { welcomed.socket.close(); });
    const repeatedEvents: any[] = [];
    welcomed.socket.on("server.event", (event) => repeatedEvents.push(event));
    const repeatedError = nextEvent(welcomed.socket, "error");
    const repeatedDisconnected = new Promise<void>((resolve) => welcomed.socket.once("disconnect", () => resolve()));
    for (let index = 0; index < 100; index += 1) welcomed.socket.emit("client.event", { type: "protocol.hello", eventId: uuid(), supportedVersions: [1] });
    expect((await repeatedError).code).toBe("INVALID_EVENT");
    await repeatedDisconnected;
    expect(repeatedEvents.filter(({ type }) => type === "error")).toHaveLength(1);
  });

  it("shares command tokens across sockets for one session and refills for reconnect", async () => {
    let now = 10_000;
    const app = buildApp({
      battleEngine: new FakeBattleEngine(), now: () => now, sweepIntervalMs: 0,
      rateLimitBurst: 2, rateLimitRefillPerSecond: 1,
    });
    closers.push(() => app.close());
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("No address");
    const url = `http://127.0.0.1:${address.port}`;
    const first = await connect(url, "Shared");
    const second = await connect(url, "Shared resumed", first.token);
    closers.push(() => { first.socket.close(); }, () => { second.socket.close(); });
    const received: any[] = [];
    for (const socket of [first.socket, second.socket]) socket.on("server.event", (event) => { if (event.type === "error") received.push(event); });
    for (const socket of [first.socket, second.socket]) {
      socket.emit("client.event", { malformed: 1 });
      socket.emit("client.event", { malformed: 2 });
    }
    while (received.length < 4) await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(received.filter(({ code }) => code === "INVALID_EVENT")).toHaveLength(2);
    expect(received.filter(({ code }) => code === "RATE_LIMITED")).toHaveLength(2);
    first.socket.close(); second.socket.close();
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
    now += 1_000;
    const reconnected = await connect(url, "Shared reconnect", first.token);
    closers.push(() => { reconnected.socket.close(); });
    const afterRefill = nextEvent(reconnected.socket, "error");
    reconnected.socket.emit("client.event", { malformed: true });
    expect((await afterRefill).code).toBe("INVALID_EVENT");
  });

  it("never prunes active room participants to admit a new retained session", async () => {
    const app = buildApp({ battleEngine: new FakeBattleEngine(), sweepIntervalMs: 0, maxRetainedSessions: 2 });
    closers.push(() => app.close());
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("No address");
    const url = `http://127.0.0.1:${address.port}`;
    const [p1, p2] = await Promise.all([connect(url, "Protected 1"), connect(url, "Protected 2")]);
    closers.push(() => { p1.socket.close(); }, () => { p2.socket.close(); });
    const created = nextEvent(p1.socket, "room.snapshot");
    p1.socket.emit("client.event", command("room.create", { name: "Protected" }));
    const room = await created;
    const joined = nextEvent(p2.socket, "room.snapshot");
    p2.socket.emit("client.event", command("room.join", { roomId: room.roomId, role: "player" }));
    await joined;
    const blocked = io(url, { transports: ["websocket"], reconnection: false, auth: { displayName: "Blocked" } });
    closers.push(() => { blocked.close(); });
    await new Promise<void>((resolve) => blocked.once("connect", resolve));
    const capacity = nextEvent(blocked, "error");
    blocked.emit("client.event", { type: "protocol.hello", eventId: uuid(), supportedVersions: [1] });
    expect((await capacity).code).toBe("SESSION_CAPACITY");
    expect(app.realtimeGateway.debugCounts.sessions).toBe(2);
  });

  it("rate-limits design requests before validation, refills, and isolates sessions", async () => {
    let now = 2_000;
    const app = buildApp({
      battleEngine: new FakeBattleEngine(), now: () => now, sweepIntervalMs: 0,
      designRateBurst: 2, designRateRefillPerSecond: 1, maxDesignsPerSession: 1, bodyLimit: 4_096,
    });
    closers.push(() => app.close());
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("No address");
    const url = `http://127.0.0.1:${address.port}`;
    const [first, other] = await Promise.all([connect(url, "First"), connect(url, "Other")]);
    closers.push(() => { first.socket.close(); }, () => { other.socket.close(); });
    const post = (token: string, payload: any) => app.inject({
      method: "POST", url: "/api/designs", headers: { authorization: `Bearer ${token}` }, payload,
    });
    expect((await post(first.token, {})).statusCode).toBe(422);
    expect((await post(first.token, { invalid: true })).statusCode).toBe(422);
    expect((await post(first.token, makeDefaultDesign())).statusCode).toBe(429);
    expect((await post(other.token, makeDefaultDesign())).statusCode).toBe(201);
    now += 1_000;
    expect((await post(first.token, makeDefaultDesign())).statusCode).toBe(201);
    now += 1_000;
    expect((await post(first.token, { padding: "x".repeat(8_000) })).statusCode).toBe(429);
  });

  it("fails fast on invalid runtime limits and requires a proxy-aware client key in production", () => {
    expect(() => buildApp({ battleEngine: new FakeBattleEngine(), maxMatchAttempts: 1_001 })).toThrow(/1000/u);
    expect(() => buildApp({ battleEngine: new FakeBattleEngine(), handshakeTimeoutMs: Number.NaN })).toThrow(/handshakeTimeoutMs/u);
    expect(() => buildApp({ battleEngine: new FakeBattleEngine(), maxRooms: 1, maxOwnedRoomsPerSession: 2 })).toThrow(/maxOwnedRoomsPerSession/u);
    expect(() => buildApp({ battleEngine: new FakeBattleEngine(), clientKeyResolver: () => "untrusted" })).toThrow(/trusted boundary/u);
    vi.stubEnv("NODE_ENV", "production");
    expect(() => buildApp({ battleEngine: new FakeBattleEngine(), allowedOrigins: ["https://school.example"], behindProxy: true })).toThrow(/clientKeyResolver/u);
  });

  it("uses an injected proxy client-key resolver instead of collapsing students onto the proxy IP", async () => {
    const app = buildApp({
      battleEngine: new FakeBattleEngine(), sweepIntervalMs: 0, maxConnectionsPerIp: 1,
      behindProxy: true,
      clientKeyResolver: (request) => String(request.headers["x-student-device"] ?? "missing"),
    });
    closers.push(() => app.close());
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("No address");
    const url = `http://127.0.0.1:${address.port}`;
    const make = (key: string) => io(url, {
      transports: ["websocket"], reconnection: false, extraHeaders: { "x-student-device": key }, auth: { displayName: key },
    });
    const first = make("device-a");
    const second = make("device-b");
    closers.push(() => { first.close(); }, () => { second.close(); });
    await Promise.all([first, second].map((socket) => new Promise<void>((resolve) => socket.once("connect", resolve))));
    expect(first.connected).toBe(true);
    expect(second.connected).toBe(true);
    const duplicate = make("device-a");
    closers.push(() => { duplicate.close(); });
    await new Promise<void>((resolve) => duplicate.once("disconnect", () => resolve()));
    expect(duplicate.connected).toBe(false);
  });

  it("uses the same strict origin policy for websocket requests and production composition", async () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(() => buildApp({ battleEngine: new FakeBattleEngine(), sweepIntervalMs: 0 })).toThrow(/allowedOrigins/u);
    vi.stubEnv("NODE_ENV", "test");
    const app = buildApp({
      battleEngine: new FakeBattleEngine(), sweepIntervalMs: 0,
      allowedOrigins: ["https://school.example"], allowMissingOrigin: false,
    });
    closers.push(() => app.close());
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("No address");
    const url = `http://127.0.0.1:${address.port}`;
    const allowed = io(url, { transports: ["websocket"], extraHeaders: { Origin: "https://school.example" }, auth: { displayName: "Allowed" } });
    closers.push(() => { allowed.close(); });
    await new Promise<void>((resolve, reject) => { allowed.once("connect", resolve); allowed.once("connect_error", reject); });
    const rejected = io(url, { transports: ["websocket"], reconnection: false, extraHeaders: { Origin: "https://evil.example" }, auth: { displayName: "Rejected" } });
    closers.push(() => { rejected.close(); });
    await new Promise<void>((resolve, reject) => {
      rejected.once("connect_error", () => resolve());
      rejected.once("connect", () => reject(new Error("Rejected origin connected")));
    });
    const missing = io(url, { transports: ["websocket"], reconnection: false, auth: { displayName: "Missing" } });
    closers.push(() => { missing.close(); });
    await new Promise<void>((resolve, reject) => {
      missing.once("connect_error", () => resolve());
      missing.once("connect", () => reject(new Error("Missing origin connected")));
    });
  });

  it("maps unknown internal failures to a generic public error without leaking details", async () => {
    const rooms = new RoomService();
    vi.spyOn(rooms, "create").mockImplementation(() => { throw new Error("database password was exposed"); });
    const logged: unknown[] = [];
    const app = buildApp({ battleEngine: new FakeBattleEngine(), rooms, sweepIntervalMs: 0, logError: (error) => logged.push(error) });
    closers.push(() => app.close());
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("No address");
    const client = await connect(`http://127.0.0.1:${address.port}`, "Safe error");
    closers.push(() => { client.socket.close(); });
    const failed = nextEvent(client.socket, "error");
    client.socket.emit("client.event", command("room.create", { name: "Failure" }));
    const event = await failed;
    expect(event).toMatchObject({ code: "COMMAND_FAILED", message: "Command could not be completed" });
    expect(JSON.stringify(event)).not.toContain("database password");
    expect(logged).toHaveLength(1);
  });

  it("serves health and rejects unsupported or malformed protocol events without crashing", async () => {
    const app = buildApp({ battleEngine: new FakeBattleEngine(), sweepIntervalMs: 0 });
    closers.push(() => app.close());
    expect((await app.inject({ method: "GET", url: "/health" })).json()).toEqual({ status: "ok", identity: { iclass: "disabled" } });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("No address");
    const raw = io(`http://127.0.0.1:${address.port}`, { transports: ["websocket"], auth: { displayName: "  學生 A  " } });
    closers.push(() => { raw.close(); });
    await new Promise<void>((resolve) => raw.once("connect", resolve));
    const unsupported = nextEvent(raw, "protocol.unsupported");
    const unsupportedDisconnected = new Promise<void>((resolve) => raw.once("disconnect", () => resolve()));
    raw.emit("client.event", { type: "protocol.hello", eventId: uuid(), supportedVersions: [9] });
    expect((await unsupported).supportedVersions).toEqual([1]);
    await unsupportedDisconnected;
    const malformed = io(`http://127.0.0.1:${address.port}`, { transports: ["websocket"], auth: { displayName: "學生 B" } });
    closers.push(() => { malformed.close(); });
    await new Promise<void>((resolve) => malformed.once("connect", resolve));
    const error = nextEvent(malformed, "error");
    const preHelloDisconnected = new Promise<void>((resolve) => malformed.once("disconnect", () => resolve()));
    malformed.emit("client.event", { type: "room.create", nope: true });
    expect((await error).code).toBe("INVALID_EVENT");
    await preHelloDisconnected;
    expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
  });

  it("returns an opaque session, authoritatively registers designs, and prevents cross-session ready", async () => {
    const app = buildApp({ battleEngine: new FakeBattleEngine(), sweepIntervalMs: 0 });
    closers.push(() => app.close());
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("No address");
    const url = `http://127.0.0.1:${address.port}`;
    const alice = await connect(url, " Alice ");
    const bob = await connect(url, "Bob");
    closers.push(() => { alice.socket.close(); }, () => { bob.socket.close(); });
    expect(alice.token).toHaveLength(64);
    expect(alice.token).not.toBe(bob.token);

    const roomSnapshot = nextEvent(alice.socket, "room.snapshot");
    const firstAck = nextEvent(alice.socket, "command.ack");
    const createEvent = command("room.create", { name: "  測試房  " });
    alice.socket.emit("client.event", createEvent);
    const room = await roomSnapshot;
    expect(await firstAck).toMatchObject({ status: "applied", commandType: "room.create", causedByEventId: createEvent.eventId });
    expect(room.name).toBe("測試房");
    const replayAck = nextEvent(alice.socket, "command.ack");
    alice.socket.emit("client.event", createEvent);
    expect(await replayAck).toMatchObject({ status: "replayed", commandType: "room.create", causedByEventId: createEvent.eventId });

    const response = await app.inject({
      method: "POST", url: "/api/designs",
      headers: { authorization: `Bearer ${alice.token}` },
      payload: makeDefaultDesign(),
    });
    expect(response.statusCode).toBe(201);
    const { designId } = response.json();

    const unauthorized = nextEvent(bob.socket, "error");
    bob.socket.emit("client.event", command("room.join", { roomId: room.roomId, role: "player" }));
    await nextEvent(bob.socket, "room.snapshot");
    bob.socket.emit("client.event", command("player.ready", { roomId: room.roomId, designId }));
    expect((await unauthorized).code).toBe("DESIGN_NOT_OWNED");

    expect((await app.inject({ method: "POST", url: "/api/designs", payload: makeDefaultDesign() })).statusCode).toBe(401);
    const invalid = makeDefaultDesign();
    invalid.layers[0].diameterMm = 80;
    expect((await app.inject({ method: "POST", url: "/api/designs", headers: { authorization: `Bearer ${alice.token}` }, payload: invalid })).statusCode).toBe(422);
  });

  it("rolls back pins, room state, match maps, and launch jobs when initial match setup throws", async () => {
    for (const failure of ["phase", "schedule"] as const) {
      const rooms = failure === "phase" ? new FailFirstPhaseRoomService() : new RoomService();
      const designs = new DesignRegistry();
      const launch = failure === "schedule" ? new FailFirstScheduleCoordinator() : new LaunchCoordinator();
      const app = buildApp({ battleEngine: new FakeBattleEngine(), rooms, designs, launch, sweepIntervalMs: 0 });
      await app.listen({ host: "127.0.0.1", port: 0 });
      const address = app.server.address();
      if (!address || typeof address === "string") throw new Error("No address");
      const url = `http://127.0.0.1:${address.port}`;
      const p1 = await connect(url, `${failure} p1`);
      const p2 = await connect(url, `${failure} p2`);
      try {
        const created = nextEvent(p1.socket, "room.snapshot");
        p1.socket.emit("client.event", command("room.create", { name: failure }));
        const room = await created;
        const joined = nextEvent(p2.socket, "room.snapshot");
        p2.socket.emit("client.event", command("room.join", { roomId: room.roomId, role: "player" }));
        await joined;
        const register = async (token: string) => (await app.inject({
          method: "POST", url: "/api/designs", headers: { authorization: `Bearer ${token}` }, payload: makeDefaultDesign(),
        })).json().designId as string;
        const [d1, d2] = await Promise.all([register(p1.token), register(p2.token)]);
        const firstReadyAck = nextEvent(p1.socket, "command.ack");
        p1.socket.emit("client.event", command("player.ready", { roomId: room.roomId, designId: d1 }));
        await firstReadyAck;
        const rollbackDeltas: any[] = [];
        p1.socket.on("server.event", (event) => { if (event.type === "room.delta") rollbackDeltas.push(event); });
        const failed = nextEvent(p2.socket, "error");
        p2.socket.emit("client.event", command("player.ready", { roomId: room.roomId, designId: d2 }));
        expect((await failed).code).toBe("COMMAND_FAILED");
        expect(app.realtimeGateway.activeMatchCount).toBe(0);
        expect(designs.debugCounts().pinned).toBe(0);
        expect(launch.activeRoundCount).toBe(0);
        await vi.waitFor(() => expect(rollbackDeltas.some((event) => event.patch.player1?.ready === false && event.patch.player2?.ready === false)).toBe(true));
        expect(rooms.get(room.roomId)).toMatchObject({
          phase: "waiting", player1: { ready: false, designId: null }, player2: { ready: false, designId: null },
        });
        const retryReadyAck = nextEvent(p1.socket, "command.ack");
        p1.socket.emit("client.event", command("player.ready", { roomId: room.roomId, designId: d1 }));
        await retryReadyAck;
        const retrySchedule = nextEvent(p1.socket, "launch.schedule");
        p2.socket.emit("client.event", command("player.ready", { roomId: room.roomId, designId: d2 }));
        expect((await retrySchedule).roomId).toBe(room.roomId);
        expect(app.realtimeGateway.activeMatchCount).toBe(1);
      } finally {
        p1.socket.close(); p2.socket.close();
        await app.close();
      }
    }
  });

  it("runs two players and 20 spectators with O(1) frame broadcasts through a private-launch match", async () => {
    let now = 1_000;
    const engine = new FakeBattleEngine();
    const matchRepository = new FailTwiceMatchRepository();
    const roomProjection = new FailWaitingRoomProjection();
    const app = buildApp({
      battleEngine: engine,
      matchRepository,
      roomRecordRepository: roomProjection,
      persistenceRetryDelaysMs: [0, 0, 0],
      now: () => now,
      launch: new LaunchCoordinator({ now: () => now, leadTimeMs: 100 }),
      sweepIntervalMs: 0,
    });
    closers.push(() => app.close());
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("No address");
    const url = `http://127.0.0.1:${address.port}`;
    const p1 = await connect(url, "P1");
    const p2 = await connect(url, "P2");
    let p2Socket = p2.socket;
    const spectators = await Promise.all(Array.from({ length: 20 }, (_, index) => connect(url, `Watcher ${index + 1}`)));
    const spectator = spectators[0]!;
    closers.push(
      () => { p1.socket.close(); },
      () => { p2Socket.close(); },
      ...spectators.map(({ socket }) => () => { socket.close(); }),
    );
    const p1Events: any[] = [];
    p1.socket.on("server.event", (event) => p1Events.push(event));

    const created = nextEvent(p1.socket, "room.snapshot");
    p1.socket.emit("client.event", command("room.create", { name: "Arena" }));
    const room = await created;
    const joined2 = nextEvent(p2.socket, "room.snapshot");
    p2.socket.emit("client.event", command("room.join", { roomId: room.roomId, role: "player" }));
    await joined2;
    await Promise.all(spectators.map(async ({ socket }) => {
      const joinedSpectator = nextEvent(socket, "room.snapshot");
      socket.emit("client.event", command("room.join", { roomId: room.roomId, role: "spectator" }));
      await joinedSpectator;
    }));

    const register = async (token: string) => (await app.inject({
      method: "POST", url: "/api/designs", headers: { authorization: `Bearer ${token}` }, payload: makeDefaultDesign(),
    })).json().designId as string;
    const d1 = await register(p1.token);
    const d2 = await register(p2.token);
    p1.socket.emit("client.event", command("player.ready", { roomId: room.roomId, designId: d1 }));
    const startedPromise = nextEvent(p1.socket, "battle.started");
    const spectatorStartedPromises = spectators.map(({ socket }) => nextEvent(socket, "battle.started"));
    const schedule1Promise = nextEvent(p1.socket, "launch.schedule");
    p2.socket.emit("client.event", command("player.ready", { roomId: room.roomId, designId: d2 }));
    const started = await startedPromise;
    const spectatorStarted = await Promise.all(spectatorStartedPromises);
    expect(spectatorStarted.every((event) => event.matchId === started.matchId)).toBe(true);
    expect(started.player1.designId).toBe(d1);
    expect(started.player2.design.layers).toHaveLength(3);
    expect(started.player2).not.toHaveProperty("ownerSessionId");
    const schedule1 = await schedule1Promise;
    const lateSpectator = await connect(url, "Late spectator");
    closers.push(() => { lateSpectator.socket.close(); });
    const lateJoined = nextEvent(lateSpectator.socket, "room.snapshot");
    lateSpectator.socket.emit("client.event", command("room.join", { roomId: room.roomId, role: "spectator" }));
    await lateJoined;
    expect(app.realtimeGateway.debugCounts.bindings).toBe(23);
    const activeLeaveRejected = nextEvent(p1.socket, "error");
    p1.socket.emit("client.event", command("room.leave", { roomId: room.roomId }));
    expect(await activeLeaveRejected).toMatchObject({ code: "ROOM_ACTIVE" });

    const playAttempt = async (schedule: any) => {
      now = schedule.serverTargetTimeMs;
      const private1 = nextEvent(p1.socket, "launch.result.private");
      const private2 = nextEvent(p2Socket, "launch.result.private");
      const publicResult = nextEvent(spectator.socket, "launch.result.spectator");
      const finalFrames = spectators.map(({ socket }) => nextEvent(socket, "battle.frame", 5_000));
      p1.socket.emit("client.event", command("launch.tap", { roomId: room.roomId, roundId: schedule.roundId, nonce: schedule.nonce, clientTimeMs: now }));
      p2Socket.emit("client.event", command("launch.tap", { roomId: room.roomId, roundId: schedule.roundId, nonce: schedule.nonce, clientTimeMs: now }));
      const [own1, own2, both, ...frames] = await Promise.all([private1, private2, publicResult, ...finalFrames]);
      expect(own1.participantId).not.toBe(own2.participantId);
      expect(own1).not.toHaveProperty("player2");
      expect(both.player1.grade).toBe("Perfect");
      expect(frames.every((frame) => frame.matchId === started.matchId && frame.tick === frames[0]!.tick)).toBe(true);
    };

    const schedule2Promise = nextEvent(p1.socket, "launch.schedule", 5_000);
    await playAttempt(schedule1);
    const schedule2 = await schedule2Promise;
    now = schedule2.serverTargetTimeMs;
    const p2OwnBeforeDisconnect = nextEvent(p2Socket, "launch.result.private");
    p2Socket.emit("client.event", command("launch.tap", { roomId: room.roomId, roundId: schedule2.roundId, nonce: schedule2.nonce, clientTimeMs: now }));
    expect((await p2OwnBeforeDisconnect).participantId).toBe(started.player2.participantId);
    p2Socket.close();
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    const resumedSocket = io(url, { transports: ["websocket"], auth: { displayName: "P2 renamed", sessionToken: p2.token } });
    await new Promise<void>((resolve) => resumedSocket.once("connect", resolve));
    const resumeWelcome = nextEvent(resumedSocket, "protocol.welcome");
    const resumeSnapshot = nextEvent(resumedSocket, "room.snapshot");
    const resumeStarted = nextEvent(resumedSocket, "battle.started");
    const resumeCheckpoint = nextEvent(resumedSocket, "battle.checkpoint");
    const resumeSchedule = nextEvent(resumedSocket, "launch.schedule");
    const resumePrivate = nextEvent(resumedSocket, "launch.result.private");
    const leaked: any[] = [];
    resumedSocket.on("server.event", (event) => {
      if (event.type === "launch.result.private") leaked.push(event);
    });
    resumedSocket.emit("client.event", { type: "protocol.hello", eventId: uuid(), supportedVersions: [1] });
    expect((await resumeWelcome).sessionStatus).toBe("resumed");
    expect((await resumeSnapshot).player2).toMatchObject({
      displayName: "P2", ready: true, designId: d2,
    });
    expect((await resumeStarted).matchId).toBe(started.matchId);
    expect((await resumeCheckpoint).roundWinners).toEqual(["player1"]);
    expect((await resumeSchedule).roundId).toBe(schedule2.roundId);
    expect((await resumePrivate).participantId).toBe(started.player2.participantId);
    expect(leaked.every((event) => event.participantId === started.player2.participantId)).toBe(true);
    p2Socket = resumedSocket;
    const matchFinished = nextEvent(p1.socket, "match.finished", 5_000);
    const spectatorFinished = spectators.map(({ socket }) => nextEvent(socket, "match.finished", 5_000));
    const spectatorFinalFramesRound2 = spectators.map(({ socket }) => nextEvent(socket, "battle.frame", 5_000));
    const finalPrivate = nextEvent(p1.socket, "launch.result.private");
    const finalSpectator = nextEvent(spectator.socket, "launch.result.spectator");
    p1.socket.emit("client.event", command("launch.tap", { roomId: room.roomId, roundId: schedule2.roundId, nonce: schedule2.nonce, clientTimeMs: now }));
    await Promise.all([finalPrivate, finalSpectator]);
    const match = await matchFinished;
    const finalFramesRound2 = await Promise.all(spectatorFinalFramesRound2);
    expect(finalFramesRound2.every((frame) => frame.matchId === match.matchId && frame.tick === finalFramesRound2[0]!.tick)).toBe(true);
    expect((await Promise.all(spectatorFinished)).every((event) => event.matchId === match.matchId)).toBe(true);
    expect(match.roundWinners).toEqual(["player1", "player1"]);
    expect(engine.simulationCount).toBe(2);
    expect(app.realtimeGateway.debugCounts.frameBroadcastOperations).toBe(2);
    expect(app.realtimeGateway.activeMatchCount).toBe(0);
    expect(app.realtimeGateway.debugCounts.terminalMatches).toBe(1);
    expect(p1Events.some((event) => event.type === "launch.result.spectator")).toBe(false);
    expect(p1Events.filter((event) => event.type === "match.finished")).toHaveLength(1);
    expect(p1Events.filter((event) => event.type === "error" && event.code === "BATTLE_FAILED")).toHaveLength(0);
    await vi.waitFor(() => expect(roomProjection.waitingFailures).toBe(1));
    expect(app.realtimeGateway.activeMatchCount).toBe(0);
    expect(matchRepository.records.get(match.matchId)).toMatchObject({ spectatorCount: 20, roundWinners: ["player1", "player1"] });
    expect(matchRepository.records.get(match.matchId)?.rounds).toHaveLength(2);
    expect(matchRepository.saveCalls).toBe(3);
    expect(p1Events.filter((event) => event.type === "match.persistence").map((event) => event.status)).toEqual(["saving", "retrying", "retrying"]);
    expect(p1Events.findLastIndex((event) => event.type === "match.persistence")).toBeLessThan(p1Events.findIndex((event) => event.type === "match.finished"));

    const finishedAt = now;
    const reconnectingSpectator = spectators[0]!;
    reconnectingSpectator.socket.close();
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    now = finishedAt + 30_000;
    const restoredSpectator = io(url, { transports: ["websocket"], auth: { displayName: "Watcher 1", sessionToken: reconnectingSpectator.token } });
    await new Promise<void>((resolve) => restoredSpectator.once("connect", resolve));
    closers.push(() => { restoredSpectator.close(); });
    const spectatorWelcome = nextEvent(restoredSpectator, "protocol.welcome");
    const spectatorTerminal = nextEvent(restoredSpectator, "match.finished");
    restoredSpectator.emit("client.event", { type: "protocol.hello", eventId: uuid(), supportedVersions: [1] });
    expect((await spectatorWelcome).sessionStatus).toBe("resumed");
    expect(await spectatorTerminal).toEqual(match);

    const revokedSpectator = spectators[1]!;
    const revokedDeparture = nextEvent(revokedSpectator.socket, "room.departed");
    revokedSpectator.socket.emit("client.event", command("room.leave", { roomId: room.roomId }));
    await revokedDeparture;
    const spectatorLeak = vi.fn();
    revokedSpectator.socket.on("server.event", (event) => { if (event.type === "match.finished") spectatorLeak(event); });
    const rejoinedSpectator = nextEvent(revokedSpectator.socket, "room.snapshot");
    revokedSpectator.socket.emit("client.event", command("room.join", { roomId: room.roomId, role: "spectator" }));
    await rejoinedSpectator;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(spectatorLeak).not.toHaveBeenCalled();

    const resumeTerminal = async (elapsedMs: number) => {
      p2Socket.close();
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      now = finishedAt + elapsedMs;
      const socket = io(url, { transports: ["websocket"], auth: { displayName: "P2", sessionToken: p2.token } });
      await new Promise<void>((resolve) => socket.once("connect", resolve));
      const welcome = nextEvent(socket, "protocol.welcome");
      const restoredStarted = nextEvent(socket, "battle.started");
      const restoredCheckpoint = nextEvent(socket, "battle.checkpoint");
      const restoredFrame = nextEvent(socket, "battle.frame");
      const restoredFinished = nextEvent(socket, "match.finished");
      socket.emit("client.event", { type: "protocol.hello", eventId: uuid(), supportedVersions: [1] });
      expect((await welcome).sessionStatus).toBe("resumed");
      expect((await restoredStarted).matchId).toBe(match.matchId);
      expect(await restoredCheckpoint).toMatchObject({ matchId: match.matchId, phase: "result", roundWinners: match.roundWinners });
      expect((await restoredFrame).matchId).toBe(match.matchId);
      expect(await restoredFinished).toEqual(match);
      p2Socket = socket;
    };
    await resumeTerminal(30_000);
    await resumeTerminal(119_000);
    const playerDeparture = nextEvent(p1.socket, "room.departed");
    p1.socket.emit("client.event", command("room.leave", { roomId: room.roomId }));
    await playerDeparture;
    const playerLeak = vi.fn();
    p1.socket.on("server.event", (event) => { if (event.type === "match.finished") playerLeak(event); });
    const rejoinedPlayer = nextEvent(p1.socket, "room.snapshot");
    p1.socket.emit("client.event", command("room.join", { roomId: room.roomId, role: "player" }));
    await rejoinedPlayer;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(playerLeak).not.toHaveBeenCalled();
    p2Socket.close();
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    now = finishedAt + 120_001;
    await app.realtimeGateway.pump(now);
    expect(app.realtimeGateway.debugCounts.terminalMatches).toBe(0);
    const expired = await connect(url, "P2", p2.token);
    p2Socket = expired.socket;
    const leakedTerminal = vi.fn();
    p2Socket.on("server.event", (event) => {
      if (event.type === "match.finished") leakedTerminal(event);
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(leakedTerminal).not.toHaveBeenCalled();
  });

  it("retries a draw without counting it as a scored round", async () => {
    let now = 10_000;
    const engine = new FakeBattleEngine();
    engine.outcomes = ["throw", "draw", "player1", "player1", "player1"];
    let scoreAttempts = 0;
    const app = buildApp({
      battleEngine: engine, now: () => now,
      launch: new LaunchCoordinator({ now: () => now, leadTimeMs: 100 }), sweepIntervalMs: 0,
      scoreMatch: (input) => {
        scoreAttempts += 1;
        if (scoreAttempts === 1) throw new Error("injected scoring failure");
        return scoreMatch(input);
      },
    });
    closers.push(() => app.close());
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("No address");
    const url = `http://127.0.0.1:${address.port}`;
    const p1 = await connect(url, "D1");
    const p2 = await connect(url, "D2");
    closers.push(() => { p1.socket.close(); }, () => { p2.socket.close(); });
    const created = nextEvent(p1.socket, "room.snapshot");
    p1.socket.emit("client.event", command("room.create", { name: "Draw retry" }));
    const room = await created;
    const joined = nextEvent(p2.socket, "room.snapshot");
    p2.socket.emit("client.event", command("room.join", { roomId: room.roomId, role: "player" }));
    await joined;
    const register = async (token: string) => (await app.inject({
      method: "POST", url: "/api/designs", headers: { authorization: `Bearer ${token}` }, payload: makeDefaultDesign(),
    })).json().designId as string;
    const [d1, d2] = await Promise.all([register(p1.token), register(p2.token)]);
    p1.socket.emit("client.event", command("player.ready", { roomId: room.roomId, designId: d1 }));
    const firstSchedule = nextEvent(p1.socket, "launch.schedule");
    p2.socket.emit("client.event", command("player.ready", { roomId: room.roomId, designId: d2 }));
    let schedule = await firstSchedule;
    now = schedule.serverTargetTimeMs;
    const retryError = nextEvent(p1.socket, "error", 5_000);
    const retrySchedule = nextEvent(p1.socket, "launch.schedule", 5_000);
    p1.socket.emit("client.event", command("launch.tap", { roomId: room.roomId, roundId: schedule.roundId, nonce: schedule.nonce, clientTimeMs: now }));
    p2.socket.emit("client.event", command("launch.tap", { roomId: room.roomId, roundId: schedule.roundId, nonce: schedule.nonce, clientTimeMs: now }));
    expect((await retryError).code).toBe("BATTLE_FAILED");
    const failedRoundId = schedule.roundId;
    schedule = await retrySchedule;
    expect(schedule.roundId).not.toBe(failedRoundId);
    let firstWinner: string | undefined;
    let matchPromise: Promise<any> | undefined;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      now = schedule.serverTargetTimeMs;
      const scoreWillFail = attempt === 2;
      const completion = scoreWillFail
        ? nextEvent(p1.socket, "error", 5_000)
        : nextEvent(p1.socket, "round.finished", 5_000);
      const nextSchedule = attempt < 3 ? nextEvent(p1.socket, "launch.schedule", 5_000) : undefined;
      if (attempt === 3) matchPromise = nextEvent(p1.socket, "match.finished", 5_000);
      p1.socket.emit("client.event", command("launch.tap", { roomId: room.roomId, roundId: schedule.roundId, nonce: schedule.nonce, clientTimeMs: now }));
      p2.socket.emit("client.event", command("launch.tap", { roomId: room.roomId, roundId: schedule.roundId, nonce: schedule.nonce, clientTimeMs: now }));
      const completedEvent = await completion;
      if (scoreWillFail) expect(completedEvent.code).toBe("BATTLE_FAILED");
      else firstWinner ??= completedEvent.winner;
      if (nextSchedule) schedule = await nextSchedule;
    }
    const finished = await matchPromise!;
    expect(firstWinner).toBe("draw");
    expect(engine.simulationCount).toBe(5);
    expect(scoreAttempts).toBe(2);
    expect(finished.roundWinners).toEqual(["player1", "player1"]);
  });

  it("cancels at the bounded attempt limit without scores and permits a clean new match", async () => {
    let now = 12_000;
    const engine = new FakeBattleEngine();
    engine.outcomes = ["draw", "draw", "player1", "player1"];
    const app = buildApp({
      battleEngine: engine, now: () => now, maxMatchAttempts: 2, sweepIntervalMs: 0,
      launch: new LaunchCoordinator({ now: () => now, leadTimeMs: 100 }),
    });
    closers.push(() => app.close());
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("No address");
    const url = `http://127.0.0.1:${address.port}`;
    const p1 = await connect(url, "Limit P1");
    const p2 = await connect(url, "Limit P2");
    closers.push(() => { p1.socket.close(); }, () => { p2.socket.close(); });
    const created = nextEvent(p1.socket, "room.snapshot");
    p1.socket.emit("client.event", command("room.create", { name: "Bounded" }));
    const room = await created;
    const joined = nextEvent(p2.socket, "room.snapshot");
    p2.socket.emit("client.event", command("room.join", { roomId: room.roomId, role: "player" }));
    await joined;
    const register = async (token: string) => (await app.inject({
      method: "POST", url: "/api/designs", headers: { authorization: `Bearer ${token}` }, payload: makeDefaultDesign(),
    })).json().designId as string;
    const [d1, d2] = await Promise.all([register(p1.token), register(p2.token)]);
    const finishedEvents: any[] = [];
    p1.socket.on("server.event", (event) => { if (event.type === "match.finished") finishedEvents.push(event); });

    const readyAndGetSchedule = async () => {
      p1.socket.emit("client.event", command("player.ready", { roomId: room.roomId, designId: d1 }));
      const scheduled = nextEvent(p1.socket, "launch.schedule");
      p2.socket.emit("client.event", command("player.ready", { roomId: room.roomId, designId: d2 }));
      return scheduled;
    };
    const play = async (schedule: any) => {
      now = schedule.serverTargetTimeMs;
      p1.socket.emit("client.event", command("launch.tap", { roomId: room.roomId, roundId: schedule.roundId, nonce: schedule.nonce, clientTimeMs: now }));
      p2.socket.emit("client.event", command("launch.tap", { roomId: room.roomId, roundId: schedule.roundId, nonce: schedule.nonce, clientTimeMs: now }));
    };

    let schedule = await readyAndGetSchedule();
    const retry = nextEvent(p1.socket, "launch.schedule");
    await play(schedule);
    schedule = await retry;
    const cancelled = nextEvent(p1.socket, "match.cancelled");
    await play(schedule);
    const cancellation = await cancelled;
    expect(cancellation).toMatchObject({ reason: "attempt-limit", matchId: expect.any(String) });
    expect(cancellation).not.toHaveProperty("player1");
    expect(engine.simulationCount).toBe(2);
    expect(app.realtimeGateway.activeMatchCount).toBe(0);
    expect(finishedEvents).toEqual([]);

    schedule = await readyAndGetSchedule();
    const secondRound = nextEvent(p1.socket, "launch.schedule");
    await play(schedule);
    schedule = await secondRound;
    const finished = nextEvent(p1.socket, "match.finished");
    await play(schedule);
    expect((await finished).roundWinners).toEqual(["player1", "player1"]);
    expect(engine.simulationCount).toBe(4);
    expect(app.realtimeGateway.debugCounts.terminalMatches).toBe(1);

    engine.outcomes = ["throw", "throw"];
    schedule = await readyAndGetSchedule();
    expect(app.realtimeGateway.debugCounts.terminalMatches).toBe(0);
    const failure1 = nextEvent(p1.socket, "error");
    const failureRetry = nextEvent(p1.socket, "launch.schedule");
    await play(schedule);
    expect((await failure1).code).toBe("BATTLE_FAILED");
    schedule = await failureRetry;
    const failure2 = nextEvent(p1.socket, "error");
    const failureCancelled = nextEvent(p1.socket, "match.cancelled");
    await play(schedule);
    expect((await failure2).code).toBe("BATTLE_FAILED");
    expect((await failureCancelled).reason).toBe("attempt-limit");
    expect(engine.simulationCount).toBe(6);
    expect(app.realtimeGateway.activeMatchCount).toBe(0);
  });

  it("restores the same participant from an opaque token, then sweeps it after two minutes", async () => {
    let now = 5_000;
    const app = buildApp({ battleEngine: new FakeBattleEngine(), now: () => now, sweepIntervalMs: 0 });
    closers.push(() => app.close());
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("No address");
    const url = `http://127.0.0.1:${address.port}`;
    const owner = await connect(url, "Original Name");
    const peer = await connect(url, "Peer");
    closers.push(() => { peer.socket.close(); });
    const created = nextEvent(owner.socket, "room.snapshot");
    owner.socket.emit("client.event", command("room.create", { name: "Reconnect" }));
    const room = await created;
    const originalParticipantId = room.viewer.participantId;
    const peerJoined = nextEvent(peer.socket, "room.snapshot");
    peer.socket.emit("client.event", command("room.join", { roomId: room.roomId, role: "player" }));
    await peerJoined;
    owner.socket.close();

    now += 60_000;
    const resumedSocket = io(url, { transports: ["websocket"], auth: { displayName: "Attempted Rename", sessionToken: owner.token } });
    await new Promise<void>((resolve) => resumedSocket.once("connect", resolve));
    const resumedWelcome = nextEvent(resumedSocket, "protocol.welcome");
    const restoredPromise = nextEvent(resumedSocket, "room.snapshot");
    resumedSocket.emit("client.event", { type: "protocol.hello", eventId: uuid(), supportedVersions: [1] });
    await resumedWelcome;
    const restored = await restoredPromise;
    closers.push(() => { resumedSocket.close(); });
    expect(restored.viewer.participantId).toBe(originalParticipantId);
    expect(restored.player1.displayName).toBe("Original Name");
    resumedSocket.close();
    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    now += 120_001;
    const removed = nextEvent(peer.socket, "room.delta");
    const sweptLobby = nextEvent(peer.socket, "lobby.snapshot");
    await app.realtimeGateway.pump(now);
    const removalDelta = await removed;
    expect(removalDelta.patch.player1).toBeNull();
    expect(removalDelta.patch.ownerParticipantId).toBeDefined();
    expect((await sweptLobby).rooms[0].player1.displayName).toBeNull();

    const replacementSocket = io(url, { transports: ["websocket"], auth: { displayName: "Replacement", sessionToken: owner.token } });
    await new Promise<void>((resolve) => replacementSocket.once("connect", resolve));
    closers.push(() => { replacementSocket.close(); });
    const replacementWelcome = nextEvent(replacementSocket, "protocol.welcome");
    replacementSocket.emit("client.event", { type: "protocol.hello", eventId: uuid(), supportedVersions: [1] });
    const replacementWelcomeEvent = await replacementWelcome;
    const replacementToken = replacementWelcomeEvent.sessionToken as string;
    expect(replacementWelcomeEvent.sessionStatus).toBe("replaced");
    expect(replacementToken).not.toBe(owner.token);
    const replacementJoined = nextEvent(replacementSocket, "room.snapshot");
    replacementSocket.emit("client.event", command("room.join", { roomId: room.roomId, role: "player" }));
    const replacementRoom = await replacementJoined;
    expect(replacementRoom.viewer.participantId).not.toBe(originalParticipantId);
    const register = async (token: string) => (await app.inject({
      method: "POST", url: "/api/designs", headers: { authorization: `Bearer ${token}` }, payload: makeDefaultDesign(),
    })).json().designId as string;
    const [replacementDesign, peerDesign] = await Promise.all([register(replacementToken), register(peer.token)]);
    replacementSocket.emit("client.event", command("player.ready", { roomId: room.roomId, designId: replacementDesign }));
    const replacementSchedule = nextEvent(replacementSocket, "launch.schedule");
    peer.socket.emit("client.event", command("player.ready", { roomId: room.roomId, designId: peerDesign }));
    const activeSchedule = await replacementSchedule;
    now = activeSchedule.serverTargetTimeMs;
    const replacementPrivate = nextEvent(replacementSocket, "launch.result.private");
    replacementSocket.emit("client.event", command("launch.tap", { roomId: room.roomId, roundId: activeSchedule.roundId, nonce: activeSchedule.nonce, clientTimeMs: now }));
    peer.socket.emit("client.event", command("launch.tap", { roomId: room.roomId, roundId: activeSchedule.roundId, nonce: activeSchedule.nonce, clientTimeMs: now }));
    expect((await replacementPrivate).participantId).toBe(replacementRoom.viewer.participantId);
  });

  it("cleans room bindings, ownership quotas, sessions, and unused designs without growth", async () => {
    let now = 30_000;
    const app = buildApp({ battleEngine: new FakeBattleEngine(), now: () => now, sweepIntervalMs: 0, maxOwnedRoomsPerSession: 1 });
    closers.push(() => app.close());
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("No address");
    const owner = await connect(`http://127.0.0.1:${address.port}`, "Cleanup");
    const design = await app.inject({
      method: "POST", url: "/api/designs", headers: { authorization: `Bearer ${owner.token}` }, payload: makeDefaultDesign(),
    });
    expect(design.statusCode).toBe(201);
    for (let index = 0; index < 10; index += 1) {
      const snapshot = nextEvent(owner.socket, "room.snapshot");
      const createAck = nextEvent(owner.socket, "command.ack");
      owner.socket.emit("client.event", command("room.create", { name: `Room ${index}` }));
      const room = await snapshot;
      await createAck;
      const acknowledged = nextEvent(owner.socket, "command.ack");
      owner.socket.emit("client.event", command("room.close", { roomId: room.roomId }));
      await acknowledged;
      expect(app.realtimeGateway.debugCounts.bindings).toBe(0);
      expect(app.realtimeGateway.debugCounts.matches).toBe(0);
    }
    owner.socket.close();
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    now += 120_001;
    await app.realtimeGateway.pump(now);
    expect(app.realtimeGateway.debugCounts).toMatchObject({
      sessions: 0, bindings: 0, matches: 0, pendingBuckets: 0, sessionCommandBuckets: 0,
    });
  });

  it("paces frames at their 60 Hz ticks and gives a late spectator only the latest checkpoint", async () => {
    let now = 20_000;
    const engine = new FakeBattleEngine();
    engine.frames = [0, 4, 8].map((tick) => ({
      tick,
      player1: { x: -10 + tick, y: 0, angle: 0, angularSpeed: 10 },
      player2: { x: 10 - tick, y: 0, angle: 0, angularSpeed: 10 },
    }));
    const waits: Array<{ delayMs: number; resolve: () => void }> = [];
    const app = buildApp({
      battleEngine: engine,
      now: () => now,
      launch: new LaunchCoordinator({ now: () => now, leadTimeMs: 100 }),
      frameScheduler: (delayMs, signal) => new Promise<void>((resolve, reject) => {
        const abort = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        signal.addEventListener("abort", abort, { once: true });
        waits.push({ delayMs, resolve: () => { signal.removeEventListener("abort", abort); resolve(); } });
      }),
      sweepIntervalMs: 0,
    });
    let pacedAppClosed = false;
    closers.push(async () => { if (!pacedAppClosed) await app.close(); });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("No address");
    const url = `http://127.0.0.1:${address.port}`;
    const p1 = await connect(url, "Frame P1");
    const p2 = await connect(url, "Frame P2");
    const watcher = await connect(url, "Late watcher");
    closers.push(() => { p1.socket.close(); }, () => { p2.socket.close(); }, () => { watcher.socket.close(); });
    const created = nextEvent(p1.socket, "room.snapshot");
    p1.socket.emit("client.event", command("room.create", { name: "Paced" }));
    const room = await created;
    const joined = nextEvent(p2.socket, "room.snapshot");
    p2.socket.emit("client.event", command("room.join", { roomId: room.roomId, role: "player" }));
    await joined;
    const register = async (token: string) => (await app.inject({
      method: "POST", url: "/api/designs", headers: { authorization: `Bearer ${token}` }, payload: makeDefaultDesign(),
    })).json().designId as string;
    const [d1, d2] = await Promise.all([register(p1.token), register(p2.token)]);
    p1.socket.emit("client.event", command("player.ready", { roomId: room.roomId, designId: d1 }));
    const scheduled = nextEvent(p1.socket, "launch.schedule");
    p2.socket.emit("client.event", command("player.ready", { roomId: room.roomId, designId: d2 }));
    const schedule = await scheduled;
    now = schedule.serverTargetTimeMs;
    const firstFrame = nextEvent(p1.socket, "battle.frame");
    p1.socket.emit("client.event", command("launch.tap", { roomId: room.roomId, roundId: schedule.roundId, nonce: schedule.nonce, clientTimeMs: now }));
    p2.socket.emit("client.event", command("launch.tap", { roomId: room.roomId, roundId: schedule.roundId, nonce: schedule.nonce, clientTimeMs: now }));
    expect((await firstFrame).sequence).toBe(0);
    while (waits.length < 1) await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(waits[0]!.delayMs).toBeCloseTo(1_000 / 15, 5);

    const watcherFrames: number[] = [];
    const watcherOrder: string[] = [];
    const finalKeyframes: any[] = [];
    watcher.socket.on("server.event", (event) => {
      if (event.type === "battle.frame") { watcherFrames.push(event.sequence); watcherOrder.push(`frame:${event.sequence}`); }
      if (event.type === "battle.frame" && event.sequence === 2) finalKeyframes.push(event);
      if (event.type === "round.finished") watcherOrder.push("round.finished");
    });
    const watcherSnapshot = nextEvent(watcher.socket, "room.snapshot");
    const watcherStarted = nextEvent(watcher.socket, "battle.started");
    const watcherLaunch = nextEvent(watcher.socket, "launch.result.spectator");
    const watcherLatest = nextEvent(watcher.socket, "battle.frame");
    watcher.socket.emit("client.event", command("room.join", { roomId: room.roomId, role: "spectator" }));
    await watcherSnapshot;
    expect((await watcherStarted).player1.design.layers).toHaveLength(3);
    expect((await watcherLaunch).player2.grade).toBe("Perfect");
    expect((await watcherLatest).sequence).toBe(0);
    expect(watcherFrames).toEqual([0]);

    const secondFrame = nextEvent(p1.socket, "battle.frame");
    const watcherSecondFrame = nextEvent(watcher.socket, "battle.frame");
    waits.shift()!.resolve();
    expect((await secondFrame).sequence).toBe(1);
    expect((await watcherSecondFrame).sequence).toBe(1);
    while (waits.length < 1) await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(waits[0]!.delayMs).toBeCloseTo(1_000 / 15, 5);
    const thirdFrame = nextEvent(p1.socket, "battle.frame");
    const watcherThirdFrame = nextEvent(watcher.socket, "battle.frame");
    const roundFinished = nextEvent(p1.socket, "round.finished");
    const watcherRoundFinished = nextEvent(watcher.socket, "round.finished");
    const nextRoundSchedule = nextEvent(p1.socket, "launch.schedule");
    waits.shift()!.resolve();
    expect((await thirdFrame).sequence).toBe(2);
    expect((await watcherThirdFrame).sequence).toBe(2);
    await roundFinished;
    await watcherRoundFinished;
    expect(watcherFrames).toEqual([0, 1, 2]);
    expect(finalKeyframes[0]).toMatchObject({ tick: 8, player1: { x: -2 }, player2: { x: 2 } });
    expect(watcherOrder.indexOf("frame:2")).toBeLessThan(watcherOrder.indexOf("round.finished"));

    const secondSchedule = await nextRoundSchedule;
    now = secondSchedule.serverTargetTimeMs;
    const secondRoundFirstFrame = nextEvent(p1.socket, "battle.frame");
    const watcherSecondRoundFirstFrame = nextEvent(watcher.socket, "battle.frame");
    p1.socket.emit("client.event", command("launch.tap", { roomId: room.roomId, roundId: secondSchedule.roundId, nonce: secondSchedule.nonce, clientTimeMs: now }));
    p2.socket.emit("client.event", command("launch.tap", { roomId: room.roomId, roundId: secondSchedule.roundId, nonce: secondSchedule.nonce, clientTimeMs: now }));
    expect((await secondRoundFirstFrame).sequence).toBe(0);
    expect((await watcherSecondRoundFirstFrame).sequence).toBe(0);
    while (waits.length < 1) await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const framesBeforeClose = watcherFrames.length;
    await app.close();
    pacedAppClosed = true;
    waits.shift()?.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(app.realtimeGateway.activeMatchCount).toBe(0);
    expect(watcherFrames).toHaveLength(framesBeforeClose);
  });

  it("runs admin maintenance without overlap and awaits an active pass on close", async () => {
    let resolveMaintenance!: () => void;
    const pending = new Promise<void>((resolve) => { resolveMaintenance = resolve; });
    class SlowAdminStore extends InMemoryAdminStore {
      calls = 0;
      override async pruneExpiredSessions(): Promise<number> { this.calls++; await pending; return 0; }
    }
    const store = new SlowAdminStore();
    const auth = new AdminAuthService(store, { allowedOrigins: ["https://school.example"], csrfSecret: Buffer.alloc(32, 7) });
    const app = buildApp({ battleEngine: new FakeBattleEngine(), adminAuth: auth, adminMaintenanceIntervalMs: 5, sweepIntervalMs: 0 });
    await new Promise<void>((resolve) => setTimeout(resolve, 18));
    expect(store.calls).toBe(1);
    let closed = false;
    const closing = app.close().then(() => { closed = true; });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(closed).toBe(false);
    resolveMaintenance();
    await closing;
    expect(store.calls).toBe(1);
  });
});
