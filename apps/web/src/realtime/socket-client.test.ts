import { makeDefaultDesign } from "@steam-top/domain";
import { describe, expect, it, vi } from "vitest";

import { ClientClockEstimator, RealtimeClient, type RealtimeTransport } from "./socket-client";
import { createSafeStorage } from "./safe-storage";

class FakeTransport implements RealtimeTransport {
  auth: Record<string, unknown> = {};
  connected = false;
  emitted: Array<[string, unknown]> = [];
  listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  connect = vi.fn(() => { this.connected = true; });
  disconnect = vi.fn(() => { this.connected = false; });
  on(event: string, listener: (...args: unknown[]) => void) {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
    return this;
  }
  off(event: string, listener: (...args: unknown[]) => void) {
    this.listeners.get(event)?.delete(listener);
    return this;
  }
  emit(event: string, value: unknown) { this.emitted.push([event, value]); return this; }
  fire(event: string, value?: unknown) {
    for (const listener of this.listeners.get(event) ?? []) listener(value);
  }
}

const uuid = (digit: number) => `${digit}0000000-0000-4000-8000-000000000000`;

describe("RealtimeClient", () => {
  it("在客戶端時鐘慢 5 秒與 50ms RTT 時收旂 offset，正確轉換 server target", () => {
    const estimator = new ClientClockEstimator();
    estimator.add({ clientSentAtMs: 1_000, serverReceivedAtMs: 6_025, serverSentAtMs: 6_026, clientReceivedAtMs: 1_051 });
    expect(estimator.offsetMs).toBe(5_000);
    expect(estimator.rttMs).toBe(50);
    expect(estimator.serverToClientTime(7_000)).toBe(2_000);
  });

  it("clock pong只供視覺 offset，client以不含server timestamps的ack回覆", () => {
    let now = 1_000;
    const transport = new FakeTransport();
    const client = new RealtimeClient({ transport, now: () => now });
    client.start();
    transport.fire("connect");
    transport.fire("server.event", { type: "protocol.welcome", selectedVersion: 1, sessionToken: "s".repeat(32), sessionStatus: "new", protocolVersion: 1, serverEventId: uuid(1) });
    const ping = transport.emitted.map(([, event]) => event as any).find((event) => event.type === "clock.ping");
    expect(ping).toMatchObject({ clientSentAtMs: 1_000 });
    expect(ping).not.toHaveProperty("serverReceiveTimeMs");
    now = 1_050;
    transport.fire("server.event", { type: "clock.pong", pingId: ping.pingId, clientSentAtMs: 1_000, serverReceiveTimeMs: 6_020, serverSendTimeMs: 6_020, protocolVersion: 1, serverEventId: uuid(2) });
    const ack = transport.emitted.map(([, event]) => event as any).find((event) => event.type === "clock.ack");
    expect(ack).toMatchObject({ pingId: ping.pingId });
    expect(ack).not.toHaveProperty("serverReceiveTimeMs");
    expect(client.getState()).toMatchObject({ clockReady: true, clockOffsetMs: 4_995 });
    client.stop();
  });

  it("connect 後送出 v1 hello，並保存伺服器 session token 供重連", () => {
    const transport = new FakeTransport();
    const storage = new Map<string, string>();
    const client = new RealtimeClient({
      transport,
      storage: { get: (key) => storage.get(key) ?? null, set: (key, value) => storage.set(key, value), remove: (key) => storage.delete(key) },
    });
    client.start();
    transport.fire("connect");
    expect(transport.emitted[0]?.[0]).toBe("client.event");
    expect(transport.emitted[0]?.[1]).toMatchObject({ type: "protocol.hello", supportedVersions: [1] });

    transport.fire("server.event", {
      type: "protocol.welcome", selectedVersion: 1, sessionToken: "s".repeat(32),
      sessionStatus: "resumed", protocolVersion: 1, serverEventId: uuid(1),
    });
    expect(storage.get("steam-top.session-token")).toBe("s".repeat(32));
    expect(transport.auth.sessionToken).toBe("s".repeat(32));
    expect(client.getState()).toMatchObject({ status: "online", sessionStatus: "resumed" });
  });

  it("嚴格忽略 malformed server payload、顯示連線診斷，並在 stop 清理 listeners", () => {
    const transport = new FakeTransport();
    const client = new RealtimeClient({ transport });
    const observed = vi.fn();
    const unsubscribe = client.subscribe(observed);
    client.start();
    transport.fire("server.event", { type: "match.finished", player1: { total: 999 } });
    expect(client.getState().lastError).toContain("伺服器資料格式");
    expect(client.getState().matchFinished).toBeNull();
    transport.fire("disconnect", "transport close");
    expect(client.getState().status).toBe("reconnecting");
    unsubscribe();
    client.stop();
    expect([...transport.listeners.values()].every((listeners) => listeners.size === 0)).toBe(true);
    expect(transport.disconnect).toHaveBeenCalledOnce();
  });

  it("replaced welcome原子清空舊房間戰況及seen/pending state", () => {
    const transport = new FakeTransport(); const client = new RealtimeClient({ transport }); client.start();
    transport.fire("server.event", roomSnapshot()); transport.fire("server.event", battleStarted("old")); transport.fire("server.event", checkpoint("old", "round", 1));
    transport.fire("server.event", { type: "protocol.welcome", selectedVersion: 1, sessionToken: "n".repeat(32), sessionStatus: "replaced", protocolVersion: 1, serverEventId: uuid(9) });
    expect(client.getState()).toMatchObject({ status: "online", room: null, departurePending: false, battleStarted: null, schedule: null, frames: [], matchFinished: null, pendingActions: 0 });
    transport.fire("server.event", roomSnapshot()); expect(client.getState().room?.roomId).toBe("room-1");
  });

  it("離線command拒絕且不會buffer到transport", () => {
    const transport = new FakeTransport(); const client = new RealtimeClient({ transport }); client.start(); const before = transport.emitted.length;
    expect(() => client.command({ type: "room.create", name: "offline" })).toThrow("目前離線"); expect(transport.emitted).toHaveLength(before);
  });

  it("儲存被瀏覽器拒絕時仍可建立連線並接收 welcome", () => {
    const brokenStorage = { getItem: () => { throw new DOMException("denied", "SecurityError"); }, setItem: () => { throw new DOMException("full", "QuotaExceededError"); }, removeItem: () => { throw new DOMException("denied", "SecurityError"); } };
    const transport = new FakeTransport();
    const client = new RealtimeClient({ transport, storage: createSafeStorage(brokenStorage) });
    expect(() => client.start()).not.toThrow();
    transport.fire("connect");
    expect(() => transport.fire("server.event", welcome("new", "s"))).not.toThrow();
    expect(client.getState()).toMatchObject({ status: "online", sessionStatus: "new" });
    client.stop();
  });

  it("設計快取綁定 session 及 fingerprint，草稿改變會重新上載", async () => {
    const transport = new FakeTransport();
    const storage = createSafeStorage();
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ designId: uuid(2) }), { status: 201, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ designId: uuid(3) }), { status: 201, headers: { "content-type": "application/json" } }));
    const client = onlineClient(transport, { storage, fetcher });
    const design = makeDefaultDesign();

    expect(await client.uploadDesign(design)).toBe(uuid(2));
    const first = client.readyWithDesign("room-1", design);
    await acknowledgeLatestReady(transport, uuid(4), 1);
    expect(await first).toBe(uuid(2));
    const cached = client.readyWithDesign("room-1", design);
    await acknowledgeLatestReady(transport, uuid(5), 2);
    expect(await cached).toBe(uuid(2));
    const changed = client.readyWithDesign("room-1", { ...design, name: "改良版" });
    await acknowledgeLatestReady(transport, uuid(6), 3);
    expect(await changed).toBe(uuid(3));
    expect(fetcher).toHaveBeenCalledTimes(2);
    client.stop();
  });

  it("伺服器重啟導致快取 designId 失效時，只自動重上載並重試一次", async () => {
    const transport = new FakeTransport();
    const storage = createSafeStorage();
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ designId: uuid(2) }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ designId: uuid(3) }), { status: 201 }));
    const client = onlineClient(transport, { storage, fetcher });
    const design = makeDefaultDesign();
    const prime = client.readyWithDesign("room-1", design);
    await acknowledgeLatestReady(transport, uuid(4), 1); await prime;

    const retrying = client.readyWithDesign("room-1", design);
    await vi.waitFor(() => expect(readyCommands(transport)).toHaveLength(2));
    const stale = readyCommands(transport).at(-1)!;
    transport.fire("server.event", { type: "error", code: "DESIGN_NOT_FOUND", message: "missing", causedByEventId: stale.eventId, protocolVersion: 1, serverEventId: uuid(5) });
    await vi.waitFor(() => expect(readyCommands(transport)).toHaveLength(3));
    const replacement = readyCommands(transport).at(-1)!;
    expect(replacement.designId).toBe(uuid(3));
    transport.fire("server.event", { type: "command.ack", causedByEventId: replacement.eventId, status: "applied", protocolVersion: 1, serverEventId: uuid(6) });
    expect(await retrying).toBe(uuid(3));
    expect(fetcher).toHaveBeenCalledTimes(2);
    client.stop();
  });

  it("session replaced 後不接受舊 session 延遲上載回應", async () => {
    const transport = new FakeTransport(); const storage = createSafeStorage();
    let resolveFetch!: (response: Response) => void;
    const fetcher = vi.fn(() => new Promise<Response>((resolve) => { resolveFetch = resolve; })) as unknown as typeof fetch;
    const client = onlineClient(transport, { storage, fetcher });
    const uploading = client.uploadDesign(makeDefaultDesign());
    transport.fire("server.event", { ...welcome("replaced", "n"), serverEventId: uuid(8) });
    resolveFetch(new Response(JSON.stringify({ designId: uuid(2) }), { status: 201 }));
    await expect(uploading).rejects.toThrow("連線已更新");
    expect(storage.get("steam-top.design-cache")).toBeNull();
    client.stop();
  });

  it("新一輪 launch schedule 清除上輪 frame，避免客戶端推測新戰況", () => {
    const transport = new FakeTransport();
    const client = new RealtimeClient({ transport });
    client.start();
    transport.fire("server.event", { type: "protocol.welcome", selectedVersion: 1, sessionToken: "s".repeat(32), sessionStatus: "resumed", protocolVersion: 1, serverEventId: uuid(9) });
    transport.fire("server.event", roomSnapshot());
    transport.fire("server.event", battleStarted("match"));
    transport.fire("server.event", checkpoint("match", "round-1", 1));
    transport.fire("server.event", {
      type: "battle.frame", roomId: "room-1", matchId: "match", roundId: "round-1",
      sequence: 1, tick: 12,
      player1: { x: 0, y: 0, angle: 0, angularSpeed: 10 },
      player2: { x: 1, y: 0, angle: 0, angularSpeed: 10 },
      protocolVersion: 1, serverEventId: uuid(6),
    });
    expect(client.getState().frames).toHaveLength(1);
    transport.fire("server.event", {
      type: "launch.schedule", roomId: "room-1", matchId: "match", roundId: "round-2",
      serverTargetTimeMs: 10_000, nonce: "nonce-2", protocolVersion: 1, serverEventId: uuid(7),
    });
    expect(client.getState().frames).toEqual([]);
    transport.fire("server.event", {
      type: "launch.schedule", roomId: "room-1", matchId: "match", roundId: "round-1",
      serverTargetTimeMs: 9_000, nonce: "nonce-stale", protocolVersion: 1, serverEventId: uuid(8),
    });
    expect(client.getState()).toMatchObject({ attempt: 2, currentRoundId: "round-2", schedule: { nonce: "nonce-2" } });
  });

  it("離房在 authoritative room.departed 前保留房間，被拒絕可重試", () => {
    const transport = new FakeTransport();
    const client = new RealtimeClient({ transport });
    client.start();
    transport.fire("server.event", { type: "protocol.welcome", selectedVersion: 1, sessionToken: "s".repeat(32), sessionStatus: "resumed", protocolVersion: 1, serverEventId: uuid(9) });
    transport.fire("server.event", roomSnapshot());
    const eventId = client.command({ type: "room.leave", roomId: "room-1" });
    expect(client.getState()).toMatchObject({ departurePending: true, room: { roomId: "room-1" } });
    transport.fire("server.event", { type: "error", code: "ROOM_ACTIVE", message: "ROOM_ACTIVE", causedByEventId: eventId, protocolVersion: 1, serverEventId: uuid(4) });
    expect(client.getState()).toMatchObject({ departurePending: false, room: { roomId: "room-1" } });
    client.command({ type: "room.leave", roomId: "room-1" });
    const authoritativeDeparture = { type: "room.departed", departureId: uuid(8), roomId: "room-1", reason: "left", protocolVersion: 1, serverEventId: uuid(5) } as const;
    transport.fire("server.event", authoritativeDeparture);
    expect(client.getState()).toMatchObject({ departurePending: false, room: null });
    expect(transport.emitted.at(-1)?.[1]).toMatchObject({ type: "room.departed.ack", departureId: uuid(8) });
    const ackCount = transport.emitted.filter(([, event]) => (event as { type?: string }).type === "room.departed.ack").length;
    transport.fire("server.event", authoritativeDeparture);
    expect(transport.emitted.filter(([, event]) => (event as { type?: string }).type === "room.departed.ack")).toHaveLength(ackCount + 1);
  });

  it("authoritative snapshot 切換房間時原子清空舊 battle state", () => {
    const transport = new FakeTransport();
    const client = new RealtimeClient({ transport });
    client.start();
    transport.fire("server.event", { type: "protocol.welcome", selectedVersion: 1, sessionToken: "s".repeat(32), sessionStatus: "resumed", protocolVersion: 1, serverEventId: uuid(9) });
    transport.fire("server.event", roomSnapshot());
    transport.fire("server.event", battleStarted("old-match"));
    transport.fire("server.event", checkpoint("old-match", "old-round", 1));
    transport.fire("server.event", frame("old-match", "old-round", 1, 10, uuid(6)));
    transport.fire("server.event", { ...roomSnapshot(), roomId: "room-2", code: "XYZ789", serverEventId: uuid(7) });
    expect(client.getState()).toMatchObject({ room: { roomId: "room-2" }, battleStarted: null, schedule: null, frames: [], matchFinished: null, attempt: 0, currentRoundId: null });
    transport.fire("server.event", frame("old-match", "old-round", 2, 20, uuid(8)));
    expect(client.getState().frames).toEqual([]);
  });

  it("按 room/match/round/attempt/sequence 忽略 stale 與倒序戰況", () => {
    const transport = new FakeTransport();
    const client = new RealtimeClient({ transport });
    client.start();
    transport.fire("server.event", roomSnapshot());
    transport.fire("server.event", battleStarted("match-a"));
    transport.fire("server.event", checkpoint("match-a", "round-2", 2));
    transport.fire("server.event", frame("match-a", "round-2", 5, 20, uuid(6)));
    transport.fire("server.event", frame("match-a", "round-2", 4, 16, uuid(7)));
    transport.fire("server.event", frame("match-a", "round-1", 99, 999, uuid(8)));
    transport.fire("server.event", { ...finished("match-b"), serverEventId: uuid(9) });
    transport.fire("server.event", { ...checkpoint("match-a", "round-stale", 2), serverEventId: uuid(10) });
    transport.fire("server.event", { ...battleStarted("match-stale"), serverEventId: uuid(11) });
    expect(client.getState().frames).toHaveLength(1);
    expect(client.getState().frames[0]).toMatchObject({ sequence: 5, tick: 20 });
    expect(client.getState().matchFinished).toBeNull();
    expect(client.getState()).toMatchObject({ battleStarted: { matchId: "match-a" }, attempt: 2, currentRoundId: "round-2" });
  });
});

function roomSnapshot() {
  return { type: "room.snapshot", roomId: "room-1", code: "ABC123", name: "Room", ownerParticipantId: "p1", phase: "waiting", revision: 1,
    player1: { participantId: "p1", displayName: "One", ready: false, designId: null }, player2: null, spectators: [],
    viewer: { participantId: "p1", role: "player1", isOwner: true }, protocolVersion: 1, serverEventId: uuid(1) } as const;
}
function welcome(status: "new" | "resumed" | "replaced", tokenSeed = "s") {
  return { type: "protocol.welcome", selectedVersion: 1, sessionToken: tokenSeed.repeat(32), sessionStatus: status, protocolVersion: 1, serverEventId: uuid(9) } as const;
}
function onlineClient(transport: FakeTransport, options: Readonly<{ storage?: ReturnType<typeof createSafeStorage>; fetcher?: typeof fetch }> = {}) {
  const client = new RealtimeClient({ transport, ...options });
  client.start(); transport.fire("connect"); transport.fire("server.event", welcome("resumed")); transport.fire("server.event", roomSnapshot());
  return client;
}
function readyCommands(transport: FakeTransport) {
  return transport.emitted.map(([, event]) => event as { type?: string; eventId?: string; designId?: string }).filter((event): event is { type: "player.ready"; eventId: string; designId: string } => event.type === "player.ready" && typeof event.eventId === "string" && typeof event.designId === "string");
}
async function acknowledgeLatestReady(transport: FakeTransport, serverEventId: string, expectedCount: number) {
  await vi.waitFor(() => expect(readyCommands(transport)).toHaveLength(expectedCount));
  const ready = readyCommands(transport).at(-1)!;
  transport.fire("server.event", { type: "command.ack", causedByEventId: ready.eventId, status: "applied", protocolVersion: 1, serverEventId });
}
const publicDesign = { layers: [
  { id: "l1", position: "top", shape: "circle", points: 6, diameterMm: 40, cornerRoundness: .5, rotationDeg: 0, color: "#112233" },
  { id: "l2", position: "middle", shape: "circle", points: 6, diameterMm: 45, cornerRoundness: .5, rotationDeg: 0, color: "#223344" },
  { id: "l3", position: "bottom", shape: "circle", points: 6, diameterMm: 42, cornerRoundness: .5, rotationDeg: 0, color: "#334455" },
], screwLayout: { count: 4, radiusMm: 12, rotationDeg: 0 }, metalDiscDiameterMm: 0 } as const;
function battleStarted(matchId: string) { return { type: "battle.started", roomId: "room-1", matchId, player1: { participantId: "p1", designId: uuid(2), design: publicDesign }, player2: { participantId: "p2", designId: uuid(3), design: publicDesign }, protocolVersion: 1, serverEventId: uuid(2) } as const; }
function checkpoint(matchId: string, roundId: string, attempt: number) { return { type: "battle.checkpoint", roomId: "room-1", matchId, roundId, attempt, phase: "battle", roundWinners: [], protocolVersion: 1, serverEventId: uuid(3) } as const; }
function frame(matchId: string, roundId: string, sequence: number, tick: number, serverEventId: string) { return { type: "battle.frame", roomId: "room-1", matchId, roundId, sequence, tick, player1: { x: 0, y: 0, angle: 0, angularSpeed: 10 }, player2: { x: 1, y: 0, angle: 0, angularSpeed: 10 }, protocolVersion: 1, serverEventId } as const; }
function finished(matchId: string) { return { type: "match.finished", roomId: "room-1", matchId, player1: { battlePoints: 2, challengePoints: 0, total: 2 }, player2: { battlePoints: 0, challengePoints: 0, total: 0 }, roundWinners: ["player1", "player1"], protocolVersion: 1, serverEventId: uuid(4) } as const; }
