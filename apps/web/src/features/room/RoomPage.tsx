import type { TopDesign } from "@steam-top/domain";
import type { BattleStartedEvent, LaunchGrade, MatchFinishedEvent, RoomSnapshotEvent } from "@steam-top/protocol";
import type { CommandInput } from "../../realtime/socket-client";
import { BattleArena, type ArenaFrame } from "../battle/BattleArena";
import { MatchResult, type MatchResultView } from "../battle/MatchResult";
import { RhythmLaunch, type LaunchScheduleView } from "../battle/RhythmLaunch";
import { SpectatorList } from "./SpectatorList";
import type { GameAudio } from "../game/GameAudio";
import { gradePresentation } from "../battle/battleEffects";
import { useEffect } from "react";

export type RoomBattleView = Readonly<{
  phase: "waiting" | "launch" | "battle" | "result";
  schedule?: LaunchScheduleView | undefined;
  privateGrade?: LaunchGrade | undefined;
  spectatorGrades?: Readonly<{ player1: LaunchGrade; player2: LaunchGrade }> | undefined;
  started?: BattleStartedEvent | undefined;
  frames?: readonly ArenaFrame[] | undefined;
  roundWinner?: "player1" | "player2" | "draw" | undefined;
  matchFinished?: MatchFinishedEvent | undefined;
  cancelledReason?: "attempt-limit" | "server-error" | "admin-removed" | undefined;
  clockReady?: boolean;
  clockSamples?: number;
  clockQuality?: "syncing" | "good" | "degraded";
}>;

function publicToDesign(started: BattleStartedEvent, side: "player1" | "player2"): TopDesign {
  const player = started[side];
  return { id: player.designId, name: side, ...player.design };
}
function resultView(event: MatchFinishedEvent): MatchResultView {
  const p1 = event.roundWinners.filter((winner) => winner === "player1").length;
  const p2 = event.roundWinners.length - p1;
  return { winner: p1 === 2 ? "player1" : "player2", scoreline: `2:${Math.min(p1, p2)}` as "2:0" | "2:1", player1: event.player1, player2: event.player2 };
}
function GradeFeedback({ grade, prefix }: Readonly<{ grade: LaunchGrade; prefix: string }>) {
  const presentation = gradePresentation(grade);
  return <p className={`grade-card judgement-feedback ${presentation.className}`}><span className="grade-original">{prefix}：{grade}</span><strong>{presentation.label}</strong><em>{presentation.chinese}</em></p>;
}

export function RoomPage({ snapshot, battle, design, designId, onUseDesign, onCommand, onLeave, gameAudio, gameQuality = "auto", reducedMotion = false, departurePending = false, actionsDisabled = false }: Readonly<{
  snapshot: RoomSnapshotEvent; battle: RoomBattleView; design: TopDesign; designId?: string | null; departurePending?: boolean;
  onUseDesign?: () => void | Promise<void>; onCommand: (event: CommandInput) => void; onLeave: () => void; gameAudio?: GameAudio; gameQuality?: "auto" | "reduced"; reducedMotion?: boolean; actionsDisabled?: boolean;
}>) {
  const active = snapshot.phase !== "waiting";
  const canLaunch = snapshot.viewer.role !== "spectator" && battle.schedule;
  const focusContent = snapshot.viewer.role !== "spectator" && battle.phase === "launch";
  const battleDesigns: readonly [TopDesign, TopDesign] = battle.started ? [publicToDesign(battle.started, "player1"), publicToDesign(battle.started, "player2")] : [design, design];
  useEffect(() => {
    if (snapshot.viewer.role !== "spectator" && battle.privateGrade) {
      const presentation = gradePresentation(battle.privateGrade);
      gameAudio?.play(presentation.tone, `grade-${battle.schedule?.roundId ?? "round"}-${battle.privateGrade}`);
    }
  }, [battle.privateGrade, battle.schedule?.roundId, gameAudio, snapshot.viewer.role]);
  useEffect(() => {
    if (battle.roundWinner) gameAudio?.play("round", `round-${battle.schedule?.roundId ?? battle.roundWinner}-${battle.roundWinner}`);
    if (battle.matchFinished) gameAudio?.play("victory", `victory-${battle.matchFinished.matchId}`);
  }, [battle.matchFinished, battle.roundWinner, battle.schedule?.roundId, gameAudio]);
  return <main className={`app-shell room-page${focusContent ? " battle-focus-content" : ""}`}><header className="room-heading"><div><p className="eyebrow">房間碼 {snapshot.code}</p><h1>{snapshot.name}</h1></div><button type="button" onClick={onLeave} disabled={actionsDisabled || departurePending || (active && snapshot.viewer.role !== "spectator")}>{departurePending ? "正在離房……" : active && snapshot.viewer.role !== "spectator" ? "對戰完成後可離房" : "離開房間"}</button></header>
    <section className="seat-grid versus-grid" aria-label="對戰玩家區">{([snapshot.player1, snapshot.player2] as const).map((seat, index) => <article className={`seat-card combatant-card combatant-${index + 1} ${seat?.ready ? "is-ready" : ""}`} key={index}><span className="seat-number">玩家{index === 0 ? "一" : "二"}</span><h2>{seat?.displayName ?? "等待玩家"}{seat?.participantId === snapshot.ownerParticipantId ? <span title="房主" aria-label="房主"> ♛</span> : null}</h2><p>{seat ? (seat.ready ? "已準備·設計已鎖定" : seat.designId ? "已選設計，未準備" : "未準備") : "可自由補上空位"}</p>{snapshot.viewer.role === "spectator" && !active && seat === null ? <button disabled={actionsDisabled} onClick={() => onCommand({ type: "room.move", roomId: snapshot.roomId, target: index === 0 ? "player1" : "player2" })}>坐上此位</button> : null}</article>)}<span className="versus-mark" aria-hidden="true">VS</span></section>
    <section className="room-controls panel" aria-label="房間操作">{snapshot.viewer.role !== "spectator" && !active ? <><button className="primary-button" disabled={actionsDisabled} onClick={() => void onUseDesign?.()}>{designId ? "以已選設計準備" : "上載當前設計並準備"}</button><button disabled={actionsDisabled} onClick={() => onCommand({ type: "room.move", roomId: snapshot.roomId, target: "spectator" })}>轉到觀賽區</button></> : null}{snapshot.viewer.isOwner && !active ? <button className="danger-button" disabled={actionsDisabled || departurePending} onClick={() => onCommand({ type: "room.close", roomId: snapshot.roomId })}>{departurePending ? "正在關閉房間……" : "關閉房間"}</button> : null}</section>
    {canLaunch ? <RhythmLaunch schedule={battle.schedule!} onCommand={onCommand} onLaunch={() => gameAudio?.play("launch", `launch-${battle.schedule!.roundId}`)} reducedMotion={reducedMotion} clockReady={battle.clockReady ?? true} clockSamples={battle.clockSamples ?? 0} clockQuality={battle.clockQuality ?? "good"} /> : null}
    {snapshot.viewer.role !== "spectator" && battle.privateGrade ? <GradeFeedback grade={battle.privateGrade} prefix="你的判定" /> : null}
    {snapshot.viewer.role === "spectator" && battle.spectatorGrades ? <div className="spectator-grades"><GradeFeedback grade={battle.spectatorGrades.player1} prefix="玩家一" /><GradeFeedback grade={battle.spectatorGrades.player2} prefix="玩家二" /></div> : null}
    {(snapshot.phase === "battle" || battle.frames?.length) ? <BattleArena designs={battleDesigns} frames={battle.frames ?? []} winner={battle.matchFinished ? resultView(battle.matchFinished).winner : battle.roundWinner} reducedMotion={reducedMotion} quality={gameQuality} onEffect={(effect) => gameAudio?.play(effect.type === "heavy-impact" ? "heavy-impact" : effect.type, effect.id)} /> : null}
    {battle.roundWinner && !battle.matchFinished ? <p className="round-result" role="status">本輪勝方：{battle.roundWinner === "draw" ? "平手，重賽" : battle.roundWinner === "player1" ? "玩家一" : "玩家二"}</p> : null}
    <MatchResult result={battle.matchFinished ? resultView(battle.matchFinished) : undefined} cancelledReason={battle.cancelledReason} />
    <SpectatorList spectators={snapshot.spectators} />
  </main>;
}
