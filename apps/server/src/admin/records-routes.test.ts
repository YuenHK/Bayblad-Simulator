import { describe, expect, it } from "vitest";
import { adminRecordTimestamp } from "./records-routes";

describe("adminRecordTimestamp", () => {
  it("normalizes postgres timestamp strings to the protocol ISO form", () => {
    expect(adminRecordTimestamp("2026-08-31 15:24:42+00")).toBe("2026-08-31T15:24:42.000Z");
    expect(adminRecordTimestamp(new Date("2026-08-31T15:24:42Z"))).toBe("2026-08-31T15:24:42.000Z");
  });

  it("rejects invalid database timestamps", () => {
    expect(() => adminRecordTimestamp("not-a-date")).toThrow("INVALID_ADMIN_RECORD_TIMESTAMP");
  });
});
