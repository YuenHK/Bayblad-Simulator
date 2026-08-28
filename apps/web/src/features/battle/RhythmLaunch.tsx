import { useCallback, useEffect, useRef, useState } from "react";
import type { CommandInput } from "../../realtime/socket-client";

export type LaunchScheduleView = Readonly<{ roomId: string; matchId: string; roundId: string; nonce: string; serverTargetTimeMs: number }>;
export function RhythmLaunch({ schedule, onCommand, reducedMotion = false }: Readonly<{ schedule: LaunchScheduleView; onCommand: (command: CommandInput) => void; reducedMotion?: boolean }>) {
  const sentNonces = useRef(new Set<string>());
  const [, refresh] = useState(0);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), reducedMotion ? 500 : 50);
    return () => clearInterval(timer);
  }, [reducedMotion]);
  const launch = useCallback(() => {
    if (sentNonces.current.has(schedule.nonce)) return;
    sentNonces.current.add(schedule.nonce);
    refresh((value) => value + 1);
    onCommand({ type: "launch.tap", roomId: schedule.roomId, roundId: schedule.roundId, nonce: schedule.nonce, clientTimeMs: Date.now() });
  }, [onCommand, schedule]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => { if (event.code === "Space") { event.preventDefault(); launch(); } };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [launch]);
  const delta = schedule.serverTargetTimeMs - now;
  return (
    <section className="rhythm-launch" aria-labelledby="launch-heading">
      <h3 id="launch-heading">發射判定</h3>
      <p className="launch-countdown" aria-live="polite">{delta > 0 ? `${Math.max(0, delta / 1000).toFixed(1)} 秒` : "發射！"}</p>
      <div data-testid="rhythm-track" className={`rhythm-track${reducedMotion ? " is-reduced-motion" : ""}`} aria-hidden="true">{reducedMotion ? null : <span data-testid="moving-marker" style={{ transform: `translateX(${Math.max(-48, Math.min(48, delta / 20))}px)` }} />}<i /></div>
      <button type="button" className="launch-button" aria-label="在判定線發射" onPointerDown={(event) => { event.preventDefault(); launch(); }} onClick={launch} disabled={sentNonces.current.has(schedule.nonce)}>點擊或按 Space 發射</button>
    </section>
  );
}
