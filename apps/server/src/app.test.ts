import { makeDefaultDesign } from "@steam-top/domain";
import type { ServerEvent } from "@steam-top/protocol";
import { io, type Socket } from "socket.io-client";
import { afterEach, describe, expect, it } from "vitest";
import type { BattleInputs, BattleResult } from "./battle/engine";
import { buildApp, type BattleEnginePort } from "./app";
import { LaunchCoordinator } from "./battle/launch";

const uuid = () => crypto.randomUUID();
const command = (type: string, fields: Record<string, unknown> = {}) => ({
  type,
  protocolVersion: 1,
  eventId: uuid(),
  ...fields,
});

class FakeBattleEngine implements BattleEnginePort {
  simulationCount = 0;
  outcomes: Array<"player1" | "player2" | "draw"> = ["player1", "player1"];
  async simulateOnceAsync(_matchId: string, _roundId: string, inputs: BattleInputs): Promise<BattleResult> {
    this.simulationCount += 1;
    const winner = this.outcomes.shift() ?? "player1";
    return {
      modelVersion: "2.0.0",
      seed: inputs.seed,
      ticks: 1,
      frames: [{
        tick: 1,
        player1: { x: -10, y: 0, angle: 0, angularSpeed: 10 },
        player2: { x: 10, y: 0, angle: 0, angularSpeed: 10 },
      }],
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
  const closers: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    for (const close of closers.splice(0).reverse()) await close();
  });

  it("serves health and rejects unsupported or malformed protocol events without crashing", async () => {
    const app = buildApp({ battleEngine: new FakeBattleEngine(), sweepIntervalMs: 0 });
    closers.push(() => app.close());
    expect((await app.inject({ method: "GET", url: "/health" })).json()).toEqual({ status: "ok" });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("No address");
    const raw = io(`http://127.0.0.1:${address.port}`, { transports: ["websocket"], auth: { displayName: "  學生 A  " } });
    closers.push(() => { raw.close(); });
    await new Promise<void>((resolve) => raw.once("connect", resolve));
    const unsupported = nextEvent(raw, "protocol.unsupported");
    raw.emit("client.event", { type: "protocol.hello", eventId: uuid(), supportedVersions: [9] });
    expect((await unsupported).supportedVersions).toEqual([1]);
    const error = nextEvent(raw, "error");
    raw.emit("client.event", { type: "room.create", nope: true });
    expect((await error).code).toBe("INVALID_EVENT");
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
    expect((await firstAck).status).toBe("applied");
    expect(room.name).toBe("測試房");
    const replayAck = nextEvent(alice.socket, "command.ack");
    alice.socket.emit("client.event", createEvent);
    expect((await replayAck).status).toBe("replayed");

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

  it("runs two players and a spectator through a private-launch best-of-three match", async () => {
    let now = 1_000;
    const engine = new FakeBattleEngine();
    const app = buildApp({
      battleEngine: engine,
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
    const spectators = await Promise.all(Array.from({ length: 20 }, (_, index) => connect(url, `Watcher ${index + 1}`)));
    const spectator = spectators[0]!;
    closers.push(
      () => { p1.socket.close(); },
      () => { p2.socket.close(); },
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
    const schedule1Promise = nextEvent(p1.socket, "launch.schedule");
    p2.socket.emit("client.event", command("player.ready", { roomId: room.roomId, designId: d2 }));
    const schedule1 = await schedule1Promise;

    const playAttempt = async (schedule: any) => {
      now = schedule.serverTargetTimeMs;
      const private1 = nextEvent(p1.socket, "launch.result.private");
      const private2 = nextEvent(p2.socket, "launch.result.private");
      const publicResult = nextEvent(spectator.socket, "launch.result.spectator");
      p1.socket.emit("client.event", command("launch.tap", { roomId: room.roomId, roundId: schedule.roundId, nonce: schedule.nonce, clientTimeMs: now }));
      p2.socket.emit("client.event", command("launch.tap", { roomId: room.roomId, roundId: schedule.roundId, nonce: schedule.nonce, clientTimeMs: now }));
      const [own1, own2, both] = await Promise.all([private1, private2, publicResult]);
      expect(own1.participantId).not.toBe(own2.participantId);
      expect(own1).not.toHaveProperty("player2");
      expect(both.player1.grade).toBe("Perfect");
    };

    const schedule2Promise = nextEvent(p1.socket, "launch.schedule", 5_000);
    await playAttempt(schedule1);
    const schedule2 = await schedule2Promise;
    const matchFinished = nextEvent(p1.socket, "match.finished", 5_000);
    await playAttempt(schedule2);
    const match = await matchFinished;
    expect(match.roundWinners).toEqual(["player1", "player1"]);
    expect(engine.simulationCount).toBe(2);
    expect(p1Events.some((event) => event.type === "launch.result.spectator")).toBe(false);
    expect(p1Events.filter((event) => event.type === "match.finished")).toHaveLength(1);
  });

  it("retries a draw without counting it as a scored round", async () => {
    let now = 10_000;
    const engine = new FakeBattleEngine();
    engine.outcomes = ["draw", "player1", "player1"];
    const app = buildApp({
      battleEngine: engine, now: () => now,
      launch: new LaunchCoordinator({ now: () => now, leadTimeMs: 100 }), sweepIntervalMs: 0,
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
    let firstWinner: string | undefined;
    let matchPromise: Promise<any> | undefined;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      now = schedule.serverTargetTimeMs;
      const roundFinished = nextEvent(p1.socket, "round.finished", 5_000);
      const nextSchedule = attempt < 2 ? nextEvent(p1.socket, "launch.schedule", 5_000) : undefined;
      if (attempt === 2) matchPromise = nextEvent(p1.socket, "match.finished", 5_000);
      p1.socket.emit("client.event", command("launch.tap", { roomId: room.roomId, roundId: schedule.roundId, nonce: schedule.nonce, clientTimeMs: now }));
      p2.socket.emit("client.event", command("launch.tap", { roomId: room.roomId, roundId: schedule.roundId, nonce: schedule.nonce, clientTimeMs: now }));
      const round = await roundFinished;
      firstWinner ??= round.winner;
      if (nextSchedule) schedule = await nextSchedule;
    }
    const finished = await matchPromise!;
    expect(firstWinner).toBe("draw");
    expect(engine.simulationCount).toBe(3);
    expect(finished.roundWinners).toEqual(["player1", "player1"]);
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
    app.realtimeGateway.pump(now);
    expect((await removed).patch.player1).toBeNull();
  });
});
