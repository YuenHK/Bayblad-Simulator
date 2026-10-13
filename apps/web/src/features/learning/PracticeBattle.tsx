import { useEffect, useRef, useState } from "react";
import type { TopDesign } from "@steam-top/domain";
import { judgeLaunch } from "../../../../server/src/battle/launch";
import { presentationFrame, ROUND_DURATION_MS, ZODIAC_SKILLS } from "../../../../server/src/battle/presentation";
import { RhythmLaunch, type LaunchScheduleView } from "../battle/RhythmLaunch";
import { CinematicBattle } from "../battle/CinematicBattle";
import type { ArenaFrame } from "../battle/BattleArena";
import type { GameAudio } from "../game/GameAudio";
import { simulateInWorker } from "./simulation-client";
import type { LearningSimulation } from "./simulation";

export function PracticeBattle({ design, reducedMotion, gameAudio, onReturn }: { design: TopDesign; reducedMotion: boolean; gameAudio: GameAudio; onReturn: () => void }) {
  const [phase, setPhase] = useState<"waiting" | "launch" | "computing" | "battle" | "result">("waiting");
  const [schedule, setSchedule] = useState<LaunchScheduleView | null>(null);
  const [result, setResult] = useState<LearningSimulation | null>(null);
  const [frames, setFrames] = useState<readonly ArenaFrame[]>([]);
  const [grade, setGrade] = useState("");
  const [error, setError] = useState("");
  const controller = useRef<AbortController | null>(null);
  const launched = useRef(false);
  const trajectory = useRef<readonly ArenaFrame[]>([]);
  useEffect(() => () => controller.current?.abort(), []);
  const launch = async (delta: number) => {
    if (launched.current) return;
    launched.current = true;
    const judgement = judgeLaunch(delta);
    setGrade(judgement.grade); setPhase("computing");
    const abort = new AbortController(); controller.current = abort;
    try {
      const next = await simulateInWorker(design, abort.signal, judgement);
      if (abort.signal.aborted) return;
      const startsAtMs = Date.now() + 250;
      const presentation: NonNullable<ArenaFrame["presentation"]> = { startsAtMs, durationMs: ROUND_DURATION_MS, elapsedMs: 0, zodiacIndex: 4, skillName: ZODIAC_SKILLS[4], finisher: next.battle.outcome.winner };
      setResult(next);
      trajectory.current = Array.from({ length: 301 }, (_, sequence) => ({ ...presentationFrame(next.battle, sequence * ROUND_DURATION_MS / 300), sequence, presentation: { ...presentation, elapsedMs: sequence * ROUND_DURATION_MS / 300 } }));
      setFrames(trajectory.current.slice(0, 1));
      setPhase("battle");
    } catch (failure) { if (!abort.signal.aborted) { setError(failure instanceof Error ? failure.message : "教學對戰失敗"); setPhase("waiting"); } }
  };
  useEffect(() => {
    if (phase !== "launch" || !schedule) return;
    const timer = setTimeout(() => void launch(10_000), Math.max(0, schedule.serverDeadlineTimeMs - Date.now()));
    return () => clearTimeout(timer);
  }, [phase, schedule]);
  useEffect(() => {
    if (phase !== "battle" || !trajectory.current.length) return;
    const startsAtMs = trajectory.current[0]!.presentation!.startsAtMs;
    const timer = setInterval(() => {
      const elapsed = Math.max(0, Date.now() - startsAtMs);
      setFrames(trajectory.current.slice(0, Math.min(301, Math.floor(elapsed / ROUND_DURATION_MS * 300) + 1)));
      if (elapsed >= ROUND_DURATION_MS) { clearInterval(timer); setPhase("result"); }
    }, 33);
    return () => clearInterval(timer);
  }, [phase]);
  return <section className="panel" aria-label="教學房間">
    <h3>教學房間（本機練習・不計分）</h3>
    {error ? <p role="alert">{error}</p> : null}
    {phase === "waiting" ? <><p>你與固定電腦玩家。建立後自動準備；沒有按發射會使用最少力度。</p><button onClick={() => { launched.current = false; setError(""); const target = Date.now() + 3000; setSchedule({ roomId: "tutorial", matchId: "tutorial", roundId: "tutorial", nonce: crypto.randomUUID(), serverTargetTimeMs: target, serverDeadlineTimeMs: target + 1500 }); setPhase("launch"); }}>建立教學房間</button></> : null}
    {phase === "launch" && schedule ? <RhythmLaunch schedule={schedule} reducedMotion={reducedMotion} onCommand={command => { if (command.type === "launch.tap") void launch(command.clientTimeMs - schedule.serverTargetTimeMs); }} onLaunch={() => gameAudio.play("launch", schedule.nonce)} /> : null}
    {phase === "computing" ? <p role="status">正在本機運算……</p> : null}
    {(phase === "battle" || phase === "result") && result ? <><p>你的發射判定：{grade}</p><CinematicBattle designs={[design, result.opponent]} frames={frames} clockOffsetMs={0} reducedMotion={reducedMotion} gameAudio={gameAudio} /></> : null}
    {phase === "result" && result ? <div role="status"><p>{result.summary.winner === "player1" ? "你勝出" : result.summary.winner === "player2" ? "電腦勝出" : "平手"}。教學不產生正式對戰分數。</p><button onClick={() => { setPhase("waiting"); setResult(null); setFrames([]); onReturn(); }}>返回教學房間</button></div> : null}
  </section>;
}
