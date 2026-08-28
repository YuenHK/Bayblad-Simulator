import { makeDefaultDesign } from "../../packages/domain/src/index";
import { io } from "../../apps/server/node_modules/socket.io-client";
import { describe, expect, it, vi } from "vitest";
import { buildApp, type BattleEnginePort } from "../../apps/server/src/app";
import type { BattleInputs, BattleResult } from "../../apps/server/src/battle/engine";
import { RealtimeClient, type RealtimeTransport } from "../../apps/web/src/realtime/socket-client";

class UnusedBattleEngine implements BattleEnginePort {
  simulationCount = 0;
  async simulateOnceAsync(_matchId: string, _roundId: string, _inputs: BattleInputs): Promise<BattleResult> { throw new Error("not used"); }
  cleanup(): boolean { return true; }
}

describe("design upload shared contract", () => {
  it("buildApp/inject完整201回應可由RealtimeClient parse並正常ready", async () => {
    const app = buildApp({ battleEngine: new UnusedBattleEngine(), sweepIntervalMs: 0 });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address(); if (!address || typeof address === "string") throw new Error("No address");
    const socket = io(`http://127.0.0.1:${address.port}`, { autoConnect: false, auth: { displayName: "Contract student" } });
    const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
      const response = await app.inject({ method: "POST", url: new URL(String(input), "http://local").pathname, headers: init?.headers as Record<string, string>, payload: JSON.parse(String(init?.body)) });
      return new Response(response.body, { status: response.statusCode, headers: { "content-type": response.headers["content-type"] ?? "application/json" } });
    }) as typeof fetch;
    const client = new RealtimeClient({ transport: socket as unknown as RealtimeTransport, fetcher });
    try {
      client.start(); await vi.waitFor(() => expect(client.getState().status).toBe("online"));
      await client.commandAsync({ type: "room.create", name: "Contract room" });
      await vi.waitFor(() => expect(client.getState().room?.roomId).toBeTruthy());
      const designId = await client.readyWithDesign(client.getState().room!.roomId, makeDefaultDesign());
      expect(designId).toMatch(/^[0-9a-f-]{36}$/iu);
      await vi.waitFor(() => expect(client.getState().room?.player1).toMatchObject({ ready: true, designId }));
    } finally { client.stop(); socket.close(); await app.close(); }
  });
});
