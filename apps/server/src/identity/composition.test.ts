import { describe, expect, it } from "vitest";
import { createIClassComposition } from "./composition";

const key = Buffer.alloc(32, 4).toString("base64url");
const enabled = { WEBCLIP_SIGNING_KEYS_JSON: JSON.stringify({ k1: key }), WEBCLIP_ACTIVE_KEY_ID: "k1", WEBCLIP_AUDIENCE: "steam-top" };

describe("production iClass composition", () => {
  it("requires an explicit mode and reports explicit guest-only as disabled", async () => {
    await expect(createIClassComposition({}, null as never)).rejects.toThrow("MISSING_ICLASS_MODE");
    await expect(createIClassComposition({ ICLASS_MODE: "guest-only-explicit" }, null as never)).resolves.toEqual({ iClassStatus: "disabled" });
  });
  it("fails enabled startup when secrets, API settings, or CSV settings are absent", async () => {
    await expect(createIClassComposition({ ICLASS_MODE: "api" }, null as never)).rejects.toThrow("WEBCLIP_SIGNING_KEYS_JSON");
    await expect(createIClassComposition({ ICLASS_MODE: "api", ...enabled }, null as never)).rejects.toThrow("MISSING_ICLASS_API_URL");
    await expect(createIClassComposition({ ICLASS_MODE: "csv", ...enabled }, null as never)).rejects.toThrow("MISSING_ICLASS_DEVICE_MAP_CSV_PATH");
  });
  it("loads a strict CSV map at startup and builds API to CSV fallback", async () => {
    const csv = "externalDeviceId,deviceName,studentName,className,studentNumber\nipad-1,d,陳同學,1A,01";
    const composition = await createIClassComposition({ ICLASS_MODE: "api-csv-fallback", ...enabled, ICLASS_API_URL: "https://iclass.example/api", ICLASS_API_BEARER_TOKEN: "secret", ICLASS_DEVICE_MAP_CSV_PATH: "/managed/map.csv" }, null as never, { readCsv: async (path) => { expect(path).toBe("/managed/map.csv"); return csv; }, fetcher: async () => new Response(null, { status: 404 }) });
    expect(composition.iClassStatus).toBe("api-csv-fallback");
    await expect(composition.iClassAdapter!.resolveDevice("ipad-1")).resolves.toMatchObject({ studentName: "陳同學" });
  });
});
