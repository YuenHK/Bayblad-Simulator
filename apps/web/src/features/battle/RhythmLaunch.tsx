import { useCallback, useEffect, useRef, useState } from "react";
import type { CommandInput } from "../../realtime/socket-client";

export type LaunchScheduleView = Readonly<{ roomId: string; matchId: string; roundId: string; nonce: string; serverTargetTimeMs: number }>;
export function RhythmLaunch({ schedule, onCommand, reducedMotion = false, clockReady = true }: Readonly<{ schedule: LaunchScheduleView; onCommand: (command: CommandInput) => void; reducedMotion?: boolean; clockReady?: boolean }>) {
  const sentNonce = useRef<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [, refresh] = useState(0);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!clockReady || sentNonce.current === schedule.nonce) return;
    timerRef.current = setInterval(() => setNow(Date.now()), reducedMotion ? 500 : 50);
    return () => { if (timerRef.current) clearInterval(timerRef.current); timerRef.current = null; };
  }, [clockReady, reducedMotion, schedule.nonce]);
  useEffect(() => { sentNonce.current = null; setNow(Date.now()); }, [schedule.nonce]);
  const launch = useCallback(() => {
    if (!clockReady || sentNonce.current === schedule.nonce) return;
    sentNonce.current = schedule.nonce;
    if (timerRef.current) clearInterval(timerRef.current); timerRef.current = null;
    refresh((value) => value + 1);
    onCommand({ type: "launch.tap", roomId: schedule.roomId, roundId: schedule.roundId, nonce: schedule.nonce, clientTimeMs: Date.now() });
  }, [clockReady, onCommand, schedule]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => { if (event.code === "Space") { event.preventDefault(); launch(); } };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [launch]);
  const delta = schedule.serverTargetTimeMs - now;
  const liveText = !clockReady ? "正在同步時間" : sentNonce.current === schedule.nonce ? "已發射，等待判定" : delta <= 0 ? "發射" : delta <= 3_000 ? String(Math.ceil(delta / 1_000)) : "準備發射";
  return (
    <section className="rhythm-launch" aria-labelledby="launch-heading">
      <h3 id="launch-heading">發射判定</h3>
      <p className="launch-countdown" aria-hidden="true">{clockReady ? delta > 0 ? `${Math.max(0, delta / 1000).toFixed(1)} 秒` : "發射！" : "正在同步時間"}</p><p className="sr-only" aria-live="polite">{liveText}</p>
      <div data-testid="rhythm-track" className={`rhythm-track${reducedMotion ? " is-reduced-motion" : ""}`} aria-hidden="true">{clockReady && !reducedMotion ? <span data-testid="moving-marker" style={{ transform: `translateX(${Math.max(-48, Math.min(48, delta / 20))}px)` }} /> : null}<i /></div>
      <button type="button" className="launch-button" aria-label="在判定線發射" onPointerDown={(event) => { event.preventDefault(); launch(); }} onClick={launch} disabled={!clockReady || sentNonce.current === schedule.nonce}>點擊或按 Space 發射</button>
    </section>
  );
}
