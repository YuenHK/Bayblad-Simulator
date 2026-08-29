import { describe, expect, it } from "vitest";
import { InMemoryPlatformSettingsStore } from "./platform-settings";
import { InMemoryAdminCommandStore, adminCommandPayloadHash } from "./command-operations";

describe("durable admin control state", () => {
  it("hydrates the last platform pause value after a new gateway composition", async () => {
    const store = new InMemoryPlatformSettingsStore();
    await store.writePaused(true);
    expect(await store.readPaused()).toBe(true);
  });
  it("replays the same command outcome and rejects operation id payload conflicts", async () => {
    const store = new InMemoryAdminCommandStore(), hash = adminCommandPayloadHash({ action: "platform.pause", paused: true });
    expect((await store.accept("550e8400-e29b-41d4-a716-446655440000", hash)).created).toBe(true);
    await store.update("550e8400-e29b-41d4-a716-446655440000", "completed", 204, {});
    const replay = await store.accept("550e8400-e29b-41d4-a716-446655440000", hash);
    expect("operation" in replay && replay.operation.status).toBe("completed");
    expect(await store.accept("550e8400-e29b-41d4-a716-446655440000", adminCommandPayloadHash({ action: "platform.pause", paused: false }))).toEqual({ conflict: true });
  });
});
