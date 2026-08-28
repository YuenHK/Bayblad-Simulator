import { describe, expect, it, vi } from "vitest";

import { RealtimeClient, type RealtimeTransport } from "./socket-client";

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
  it("connect 後送出 v1 hello，並保存伺服器 session token 供重連", () => {
    const transport = new FakeTransport();
    const storage = new Map<string, string>();
    const client = new RealtimeClient({
      transport,
      storage: { get: (key) => storage.get(key) ?? null, set: (key, value) => storage.set(key, value) },
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

  it("新一輪 launch schedule 清除上輪 frame，避免客戶端推測新戰況", () => {
    const transport = new FakeTransport();
    const client = new RealtimeClient({ transport });
    client.start();
    transport.fire("server.event", {
      type: "battle.frame", roomId: "room", matchId: "match", roundId: "round-1",
      sequence: 1, tick: 12,
      player1: { x: 0, y: 0, angle: 0, angularSpeed: 10 },
      player2: { x: 1, y: 0, angle: 0, angularSpeed: 10 },
      protocolVersion: 1, serverEventId: uuid(2),
    });
    expect(client.getState().frames).toHaveLength(1);
    transport.fire("server.event", {
      type: "launch.schedule", roomId: "room", matchId: "match", roundId: "round-2",
      serverTargetTimeMs: 10_000, nonce: "nonce-2", protocolVersion: 1, serverEventId: uuid(3),
    });
    expect(client.getState().frames).toEqual([]);
  });
});
