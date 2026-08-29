import { afterEach, describe, expect, it } from "vitest";
import { buildApp, type BattleEnginePort } from "../app";
import { IdentityResolver, InMemoryIdentityStore } from "./resolver";

const battleEngine: BattleEnginePort = { simulationCount: 0, simulateOnceAsync: async () => { throw new Error("unused"); }, cleanup: () => false };
const apps: ReturnType<typeof buildApp>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

describe("identity routes", () => {
  it("automatically creates and then reuses an identity without collecting a name", async () => {
    const app = buildApp({ battleEngine, identityResolver: new IdentityResolver(new InMemoryIdentityStore()), sweepIntervalMs: 0 }); apps.push(app);
    const first = await app.inject({ method: "GET", url: "/api/identity" });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ status: "guest", displayName: expect.stringMatching(/^訪客-/) });
    expect(first.json()).not.toHaveProperty("cookieToken");
    const cookie = first.cookies.find((item) => item.name === "steam_top_identity")!;
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: "Strict", path: "/" });
    const second = await app.inject({ method: "GET", url: "/api/identity", headers: { cookie: `${cookie.name}=${cookie.value}` } });
    expect(second.json()).toEqual(first.json());
  });

  it("revokes and clears the current cookie", async () => {
    const app = buildApp({ battleEngine, identityResolver: new IdentityResolver(new InMemoryIdentityStore()), sweepIntervalMs: 0 }); apps.push(app);
    const first = await app.inject({ method: "GET", url: "/api/identity" });
    const cookie = first.cookies[0]!;
    const logout = await app.inject({ method: "POST", url: "/api/identity/logout", headers: { cookie: `${cookie.name}=${cookie.value}` } });
    expect(logout.statusCode).toBe(204);
    expect(logout.cookies[0]).toMatchObject({ name: "steam_top_identity", value: "", maxAge: 0 });
  });
});
