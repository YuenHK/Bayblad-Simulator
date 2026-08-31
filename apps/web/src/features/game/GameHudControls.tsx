import type { GamePreferences } from "./gamePreferences";

export function GameHudControls({ preferences, onChange }: Readonly<{ preferences: GamePreferences; onChange: (next: GamePreferences) => void }>) {
  return <div className="game-hud-controls" aria-label="遊戲效果設定">
    <button type="button" className="hud-icon-button" aria-label={preferences.soundEnabled ? "關閉音效" : "開啟音效"} aria-pressed={preferences.soundEnabled} onClick={() => onChange({ ...preferences, soundEnabled: !preferences.soundEnabled })}>
      <span aria-hidden="true">{preferences.soundEnabled ? "◖))" : "◖×"}</span><span className="hud-control-label">音效</span>
    </button>
    <button type="button" className="hud-icon-button" aria-label={preferences.motionEnabled ? "減少動態效果" : "啟用完整動態效果"} aria-pressed={preferences.motionEnabled} onClick={() => onChange({ ...preferences, motionEnabled: !preferences.motionEnabled })}>
      <span aria-hidden="true">{preferences.motionEnabled ? "✦" : "◇"}</span><span className="hud-control-label">動態</span>
    </button>
  </div>;
}
