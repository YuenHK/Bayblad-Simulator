import { afterEach, describe, expect, it } from "vitest";
import { io, type Socket } from "socket.io-client";
import { buildApp, type BattleEnginePort } from "../app";
import { IdentityResolver, InMemoryIdentityStore } from "./resolver";

const battleEngine: BattleEnginePort = { simulationCount: 0, simulateOnceAsync: async () => { throw new Error("unused"); }, cleanup: () => false };
const closers: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close(); });
const event = (socket: Socket, type: string) => new Promise<any>((resolve, reject) => { const timer = setTimeout(() => reject(new Error(`timeout ${type}`)), 2_000); socket.on("server.event", (value) => { if (value.type === type) { clearTimeout(timer); resolve(value); } }); });

describe("socket identity binding", () => {
  it("ignores a spoofed auth displayName and refuses a realtime token under another identity cookie", async () => {
    const app = buildApp({ battleEngine, identityResolver: new IdentityResolver(new InMemoryIdentityStore()), sweepIntervalMs: 0 }); closers.push(() => app.close());
    await app.listen({ host: "127.0.0.1", port: 0 }); const address = app.server.address(); if (!address || typeof address === "string") throw new Error("address");
    const url = `http://127.0.0.1:${address.port}`;
    const firstIdentity = await app.inject({ method: "GET", url: "/api/identity" }); const firstCookie = `${firstIdentity.cookies[0]!.name}=${firstIdentity.cookies[0]!.value}`;
    const first = io(url, { transports: ["websocket"], reconnection: false, extraHeaders: { cookie: firstCookie }, auth: { displayName: "偽造名稱" } }); closers.push(() => { first.close(); });
    await new Promise<void>((resolve) => first.once("connect", resolve)); const welcome = event(first, "protocol.welcome"); first.emit("client.event", { type: "protocol.hello", eventId: crypto.randomUUID(), supportedVersions: [1] }); const token = (await welcome).sessionToken;
    const room = event(first, "room.snapshot"); first.emit("client.event", { type: "room.create", protocolVersion: 1, eventId: crypto.randomUUID(), name: "Identity" });
    expect((await room).player1.displayName).toBe(firstIdentity.json().displayName);

    const secondIdentity = await app.inject({ method: "GET", url: "/api/identity" }); const secondCookie = `${secondIdentity.cookies[0]!.name}=${secondIdentity.cookies[0]!.value}`;
    const second = io(url, { transports: ["websocket"], reconnection: false, extraHeaders: { cookie: secondCookie }, auth: { displayName: "另一個偽名", sessionToken: token } }); closers.push(() => { second.close(); });
    await new Promise<void>((resolve) => second.once("connect", resolve)); const replaced = event(second, "protocol.welcome"); second.emit("client.event", { type: "protocol.hello", eventId: crypto.randomUUID(), supportedVersions: [1] });
    expect(await replaced).toMatchObject({ sessionStatus: "replaced" });
  });

  it("requires an HttpOnly identity cookie when a production identity resolver is composed", async () => {
    const app = buildApp({ battleEngine, identityResolver: new IdentityResolver(new InMemoryIdentityStore()), sweepIntervalMs: 0 }); closers.push(() => app.close());
    await app.listen({ host: "127.0.0.1", port: 0 }); const address = app.server.address(); if (!address || typeof address === "string") throw new Error("address");
    const socket = io(`http://127.0.0.1:${address.port}`, { transports: ["websocket"], reconnection: false, auth: { displayName: "spoof" } }); closers.push(() => { socket.close(); });
    const required = await new Promise<Error & { data?: unknown }>((resolve) => socket.once("connect_error", resolve));
    expect(required).toMatchObject({ message: "IDENTITY_REQUIRED", data: { code: "IDENTITY_REQUIRED" } });
  });
});
