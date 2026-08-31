import { describe, expect, it } from "vitest";
import { createSafeStorage } from "../../realtime/safe-storage";
import { GAME_PREFERENCES_KEY, loadGamePreferences, saveGamePreferences } from "./gamePreferences";

describe("game preferences", () => {
  it("損壞或未知版本會回復安全預設", () => {
    const storage = createSafeStorage({ getItem: () => "not-json", setItem() {}, removeItem() {} });
    expect(loadGamePreferences(storage)).toEqual({ soundEnabled: true, motionEnabled: true, quality: "auto" });
  });

  it("可往返保存靜音、低動態及精簡品質", () => {
    const values = new Map<string, string>();
    const storage = createSafeStorage({ getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) });
    const preferences = { soundEnabled: false, motionEnabled: false, quality: "reduced" as const };
    saveGamePreferences(storage, preferences);
    expect(values.has(GAME_PREFERENCES_KEY)).toBe(true);
    expect(loadGamePreferences(storage)).toEqual(preferences);
  });
});
