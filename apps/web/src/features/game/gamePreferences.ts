import type { SafeStorage } from "../../realtime/safe-storage";

export const GAME_PREFERENCES_KEY = "steam-top.game-preferences.v1";

export type GameQuality = "auto" | "reduced";
export type GamePreferences = Readonly<{
  soundEnabled: boolean;
  motionEnabled: boolean;
  quality: GameQuality;
}>;

export const DEFAULT_GAME_PREFERENCES: GamePreferences = Object.freeze({
  soundEnabled: true,
  motionEnabled: true,
  quality: "auto",
});

export function loadGamePreferences(storage: SafeStorage): GamePreferences {
  try {
    const parsed = JSON.parse(storage.get(GAME_PREFERENCES_KEY) ?? "null") as unknown;
    if (!parsed || typeof parsed !== "object") return DEFAULT_GAME_PREFERENCES;
    const value = parsed as Record<string, unknown>;
    if (typeof value.soundEnabled !== "boolean" || typeof value.motionEnabled !== "boolean" || !["auto", "reduced"].includes(String(value.quality))) return DEFAULT_GAME_PREFERENCES;
    return { soundEnabled: value.soundEnabled, motionEnabled: value.motionEnabled, quality: value.quality as GameQuality };
  } catch {
    return DEFAULT_GAME_PREFERENCES;
  }
}

export function saveGamePreferences(storage: SafeStorage, preferences: GamePreferences): void {
  storage.set(GAME_PREFERENCES_KEY, JSON.stringify(preferences));
}
