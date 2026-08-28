import { describe, expect, it } from "vitest";
import { createSafeStorage } from "./safe-storage";

describe("createSafeStorage", () => {
  it("SecurityError或quota時使用memory fallback", () => {
    const broken = { getItem() { throw new DOMException("blocked", "SecurityError"); }, setItem() { throw new DOMException("full", "QuotaExceededError"); }, removeItem() { throw new DOMException("blocked", "SecurityError"); } };
    const storage = createSafeStorage(broken);
    expect(storage.get("x")).toBeNull(); storage.set("x", "1"); expect(storage.get("x")).toBe("1"); storage.remove("x"); expect(storage.get("x")).toBeNull();
  });
});
