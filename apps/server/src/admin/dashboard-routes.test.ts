import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../app";
import { AdminAuthService, InMemoryAdminStore } from "../auth/admin-auth";
import { BattleEngine, InMemoryCompletedRoundStore } from "../battle/engine";
import { RoomService } from "../rooms/room-service";
const origin = "https://tops.example.edu.hk",
  headers = {
    origin,
    host: "tops.example.edu.hk",
    "sec-fetch-site": "same-origin",
  };
async function fixture() {
  const store = new InMemoryAdminStore(),
    auth = new AdminAuthService(store, {
      allowedOrigins: [origin],
      secureCookies: false,
    });
  await auth.bootstrap("admin", "test-password-2026");
  const rooms = new RoomService(),
    room = rooms.create({ id: "u1", displayName: "陳同學" }, "測試房"),
    resultRepository = new InMemoryCompletedRoundStore();
  const app = buildApp({
    rooms,
    adminAuth: auth,
    resultRepository,
    battleEngine: new BattleEngine({ resultRepository }),
    allowedOrigins: [origin],
    allowMissingOrigin: true,
  });
  await app.ready();
  const login = await app.inject({
      method: "POST",
      url: "/api/admin/login",
      headers,
      payload: { username: "admin", password: "test-password-2026" },
    }),
    cookie = login.cookies[0]!,
    session = await app.inject({
      method: "GET",
      url: "/api/admin/session",
      headers: {
        host: "tops.example.edu.hk",
        "sec-fetch-site": "same-origin",
        cookie: `${cookie.name}=${cookie.value}`,
      },
    });
  return {
    app,
    store,
    rooms,
    room,
    cookie: `${cookie.name}=${cookie.value}`,
    csrf: session.json().csrfToken as string,
  };
}
const apps: Awaited<ReturnType<typeof fixture>>["app"][] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
describe("admin dashboard routes", () => {
  it("lists live rooms and audits forced close", async () => {
    const f = await fixture();
    apps.push(f.app);
    const listed = await f.app.inject({
      method: "GET",
      url: "/api/admin/rooms",
      headers: {
        host: "tops.example.edu.hk",
        "sec-fetch-site": "same-origin",
        cookie: f.cookie,
      },
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().rooms[0]).toMatchObject({
      roomCode: f.room.code,
      players: [{ displayName: "陳同學" }],
    });
    const closed = await f.app.inject({
      method: "POST",
      url: "/api/admin/rooms/actions",
      headers: { ...headers, cookie: f.cookie, "x-csrf-token": f.csrf },
      payload: {
          action: "room.close",
          roomId: f.room.roomId,
          password: "test-password-2026",
          operationId: "550e8400-e29b-41d4-a716-446655440000",
      },
    });
    expect(closed.statusCode).toBe(200);
    expect(f.rooms.hasRoom(f.room.roomId)).toBe(false);
    const replayed = await f.app.inject({
      method: "POST", url: "/api/admin/rooms/actions",
      headers: { ...headers, cookie: f.cookie, "x-csrf-token": f.csrf },
      payload: { action: "room.close", roomId: f.room.roomId, password: "test-password-2026", operationId: "550e8400-e29b-41d4-a716-446655440000" },
    });
    expect(replayed.statusCode).toBe(200);
    expect(replayed.json()).toMatchObject({ status: "completed" });
    expect(
      f.store.auditEntries.some(
        (x) => x.action === "admin.room.close" && x.outcome === "success",
      ),
    ).toBe(true);
  });
  it("pauses new room admission", async () => {
    const f = await fixture();
    apps.push(f.app);
    expect(
      (
        await f.app.inject({
          method: "POST",
          url: "/api/admin/rooms/actions",
          headers: { ...headers, cookie: f.cookie, "x-csrf-token": f.csrf },
          payload: {
          action: "platform.pause",
          paused: true,
          password: "test-password-2026",
          operationId: "550e8400-e29b-41d4-a716-446655440001",
          },
        })
      ).statusCode,
    ).toBe(200);
    expect(() =>
      f.rooms.create({ id: "u2", displayName: "學生" }, "另一房"),
    ).toThrow("PLATFORM_PAUSED");
  });
  it("rejects nonexistent close and remove targets before accepting an operation", async () => {
    const f = await fixture(); apps.push(f.app);
    const request = (payload: object) => f.app.inject({ method: "POST", url: "/api/admin/rooms/actions", headers: { ...headers, cookie: f.cookie, "x-csrf-token": f.csrf }, payload });
    expect((await request({ action:"room.close",roomId:"missing",password:"test-password-2026",operationId:"550e8400-e29b-41d4-a716-446655440003" })).statusCode).toBe(404);
    expect((await request({ action:"room.remove",roomId:f.room.roomId,participantId:"missing",password:"test-password-2026",operationId:"550e8400-e29b-41d4-a716-446655440004" })).statusCode).toBe(404);
  });
  it("keeps a room open while a spectator remains after the last player is removed", async () => {
    const f = await fixture(); apps.push(f.app);
    f.rooms.join(f.room.roomId, { id: "spectator", displayName: "觀賽者" }, "spectator");
    const steps:string[]=[];
    await f.app.realtimeGateway.adminRemoveParticipant(f.room.roomId, f.room.participantId, { signal:new AbortController().signal,currentStep:"accepted_audited",fence:async(step)=>{if(step)steps.push(step);} });
    expect(steps).toEqual(["match_cancelled","phase_waiting","participant_left","session_kicked","broadcast_done","room_closed_if_empty"]);
    expect(f.rooms.hasRoom(f.room.roomId)).toBe(true);
    expect(f.rooms.adminRooms()[0]).toMatchObject({ players: [], spectators: [{ displayName: "觀賽者" }] });
    const resumed:string[]=[];
    await f.app.realtimeGateway.adminRemoveParticipant(f.room.roomId, f.room.participantId, { signal:new AbortController().signal,currentStep:"participant_left",fence:async(step)=>{if(step)resumed.push(step);} });
    expect(resumed).toEqual(["session_kicked","broadcast_done","room_closed_if_empty"]);
  });
});
