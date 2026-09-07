import { expect, it } from "vitest";
import { command } from "../../scripts/production-wss-smoke.mjs";
import { protocolHelloEventSchema, roomCreateEventSchema, launchTapEventSchema } from "../../packages/protocol/src/events";

it("encodes the initial negotiation with the exact production handshake schema", () => {
  expect(protocolHelloEventSchema.safeParse(command("protocol.hello", { supportedVersions: [1] })).success).toBe(true);
});

it("retains versioned envelopes on room and launch commands", () => {
  expect(roomCreateEventSchema.safeParse(command("room.create", { name: "smoke-room" })).success).toBe(true);
  expect(launchTapEventSchema.safeParse(command("launch.tap", {
    roomId: "room-1", roundId: "round-1", nonce: "launch-nonce", clientTimeMs: Date.now(),
  })).success).toBe(true);
});
