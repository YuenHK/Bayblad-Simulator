import type { TopDesign } from "@steam-top/domain";
import type { BattleStartedEvent, LaunchGrade, MatchFinishedEvent, RoomSnapshotEvent } from "@steam-top/protocol";
import type { CommandInput } from "../../realtime/socket-client";
import { BattleArena, type ArenaFrame } from "../battle/BattleArena";
import { MatchResult, type MatchResultView } from "../battle/MatchResult";
import { RhythmLaunch, type LaunchScheduleView } from "../battle/RhythmLaunch";
import { SpectatorList } from "./SpectatorList";

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

export function RoomPage({ snapshot, battle, design, designId, onUseDesign, onCommand, onLeave, reducedMotion = false, departurePending = false, actionsDisabled = false }: Readonly<{
  snapshot: RoomSnapshotEvent; battle: RoomBattleView; design: TopDesign; designId?: string | null; departurePending?: boolean;
  onUseDesign?: () => void | Promise<void>; onCommand: (event: CommandInput) => void; onLeave: () => void; reducedMotion?: boolean; actionsDisabled?: boolean;
}>) {
  const active = snapshot.phase !== "waiting";
  const canLaunch = snapshot.viewer.role !== "spectator" && battle.schedule;
  const battleDesigns: readonly [TopDesign, TopDesign] = battle.started ? [publicToDesign(battle.started, "player1"), publicToDesign(battle.started, "player2")] : [design, design];
  return <main className="app-shell"><header className="room-heading"><div><p className="eyebrow">房間碼 {snapshot.code}</p><h1>{snapshot.name}</h1></div><button type="button" onClick={onLeave} disabled={actionsDisabled || departurePending || (active && snapshot.viewer.role !== "spectator")}>{departurePending ? "正在離房……" : active && snapshot.viewer.role !== "spectator" ? "對戰完成後可離房" : "離開房間"}</button></header>
    <section className="seat-grid" aria-label="對戰玩家區">{([snapshot.player1, snapshot.player2] as const).map((seat, index) => <article className={`seat-card ${seat?.ready ? "is-ready" : ""}`} key={index}><span className="seat-number">玩家{index === 0 ? "一" : "二"}</span><h2>{seat?.displayName ?? "等待玩家"}{seat?.participantId === snapshot.ownerParticipantId ? <span title="房主" aria-label="房主"> ♛</span> : null}</h2><p>{seat ? (seat.ready ? "已準備·設計已鎖定" : seat.designId ? "已選設計，未準備" : "未準備") : "可自由補上空位"}</p>{snapshot.viewer.role === "spectator" && !active && seat === null ? <button disabled={actionsDisabled} onClick={() => onCommand({ type: "room.move", roomId: snapshot.roomId, target: index === 0 ? "player1" : "player2" })}>坐上此位</button> : null}</article>)}</section>
    <section className="room-controls panel" aria-label="房間操作">{snapshot.viewer.role !== "spectator" && !active ? <><button className="primary-button" disabled={actionsDisabled} onClick={() => void onUseDesign?.()}>{designId ? "以已選設計準備" : "上載當前設計並準備"}</button><button disabled={actionsDisabled} onClick={() => onCommand({ type: "room.move", roomId: snapshot.roomId, target: "spectator" })}>轉到觀賽區</button></> : null}{snapshot.viewer.isOwner && !active ? <button className="danger-button" disabled={actionsDisabled || departurePending} onClick={() => onCommand({ type: "room.close", roomId: snapshot.roomId })}>{departurePending ? "正在關閉房間……" : "關閉房間"}</button> : null}</section>
    {canLaunch ? <RhythmLaunch schedule={battle.schedule!} onCommand={onCommand} reducedMotion={reducedMotion} clockReady={battle.clockReady ?? true} clockSamples={battle.clockSamples ?? 0} clockQuality={battle.clockQuality ?? "good"} /> : null}
    {snapshot.viewer.role !== "spectator" && battle.privateGrade ? <p className="grade-card">你的判定：{battle.privateGrade}</p> : null}
    {snapshot.viewer.role === "spectator" && battle.spectatorGrades ? <div className="spectator-grades"><p>玩家一：{battle.spectatorGrades.player1}</p><p>玩家二：{battle.spectatorGrades.player2}</p></div> : null}
    {(snapshot.phase === "battle" || battle.frames?.length) ? <BattleArena designs={battleDesigns} frames={battle.frames ?? []} reducedMotion={reducedMotion} /> : null}
    {battle.roundWinner && !battle.matchFinished ? <p className="round-result" role="status">本輪勝方：{battle.roundWinner === "draw" ? "平手，重賽" : battle.roundWinner === "player1" ? "玩家一" : "玩家二"}</p> : null}
    <MatchResult result={battle.matchFinished ? resultView(battle.matchFinished) : undefined} cancelledReason={battle.cancelledReason} />
    <SpectatorList spectators={snapshot.spectators} />
  </main>;
}
