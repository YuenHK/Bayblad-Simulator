import type { BattleResult } from "./engine";

export const ROUND_DURATION_MS = 60_000;
export const SUMMON_AT_MS = 48_000;
export const ZODIAC_SKILLS = ["靈鼠・雷影穿梭", "神牛・撼地衝鋒", "猛虎・虎嘯風生", "玉兔・月影連擊", "天龍・龍騰九霄", "靈蛇・盤影破空", "天馬・奔雷踏星", "神羊・星角破陣", "靈猴・千影震天", "金雞・破曉烈光", "天犬・疾風追月", "戰豬・山嶽突進"] as const;

/** Resample the authoritative trajectory for cinematic playback; never change its outcome. */
export function presentationFrame(result: Pick<BattleResult, "ticks" | "frames">, elapsedMs: number) {
  const frames = result.frames;
  if (!frames.length) throw new Error("EMPTY_BATTLE_TRAJECTORY");
  const progress = Math.min(1, Math.max(0, elapsedMs / ROUND_DURATION_MS));
  const index = progress * (frames.length - 1);
  const left = frames[Math.floor(index)]!;
  const right = frames[Math.min(frames.length - 1, Math.ceil(index))]!;
  const mix = index - Math.floor(index);
  const body = (side: "player1" | "player2") => {
    const a = left[side], b = right[side];
    return { x: a.x + (b.x-a.x)*mix, y: a.y + (b.y-a.y)*mix, angle: a.angle + (b.angle-a.angle)*mix, angularSpeed: a.angularSpeed + (b.angularSpeed-a.angularSpeed)*mix };
  };
  return { tick: Math.round(progress * result.ticks), player1: body("player1"), player2: body("player2") };
}
