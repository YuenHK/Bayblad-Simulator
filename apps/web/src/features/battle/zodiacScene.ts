export const ZODIAC_NAMES = ["鼠", "牛", "虎", "兔", "龍", "蛇", "馬", "羊", "猴", "雞", "狗", "豬"] as const;
export function zodiacNumber(index: number): number { return ((Math.trunc(Number.isFinite(index) ? index : 0) % 12) + 12) % 12; }
export function cinematicPhase(elapsedMs: number): "battle" | "summon" | "strike" | "result" {
  if (elapsedMs >= 60000) return "result";
  if (elapsedMs >= 54000) return "strike";
  return elapsedMs >= 48000 ? "summon" : "battle";
}
export function cinematicProgress(elapsedMs: number): number { return Math.max(0, Math.min(1, (elapsedMs - 54000) / 6000)); }
import { makeLayerVertices, type TopDesign } from "@steam-top/domain";
import type { ArenaFrame } from "./BattleArena";
export type ContactSpark = { id: string; x: number; y: number; rim: boolean };
export function presentationSample(frames: readonly ArenaFrame[], elapsedMs: number): { previous: ArenaFrame | undefined; latest: ArenaFrame | undefined; mix: number } {
  const timed = frames.filter(frame => frame.presentation !== undefined);
  if (!timed.length) return { previous: frames.at(-2) ?? frames.at(-1), latest: frames.at(-1), mix: 1 };
  const nextIndex = timed.findIndex(frame => frame.presentation!.elapsedMs >= elapsedMs);
  if (nextIndex === -1) return { previous: timed.at(-1), latest: timed.at(-1), mix: 1 };
  const latest = timed[nextIndex]!;
  const previous = timed[Math.max(0,nextIndex-1)]!;
  const start = previous.presentation!.elapsedMs, end = latest.presentation!.elapsedMs;
  return { previous, latest, mix: end === start ? 1 : Math.max(0,Math.min(1,(elapsedMs-start)/(end-start))) };
}
export function designRadiusMm(design: TopDesign): number {
  return Math.max(design.metalDiscDiameterMm / 2, ...design.layers.flatMap(layer => makeLayerVertices(layer).map(p => Math.hypot(p.x,p.y))));
}
/** Frame positions and design geometry are both millimetres; engine wall is 105 mm. */
export function contactSparks(previous: ArenaFrame | undefined, latest: ArenaFrame | undefined, radii: readonly number[]): ContactSpark[] {
  if (!previous || !latest || previous.sequence === latest.sequence) return [];
  const result: ContactSpark[] = [];
  const distance = (f: ArenaFrame) => Math.hypot(f.player1.x-f.player2.x,f.player1.y-f.player2.y);
  const contact = (radii[0] ?? 0)+(radii[1] ?? 0)+2;
  if (distance(latest) <= contact && distance(previous) > contact) result.push({id:`contact-${latest.sequence}`,x:(latest.player1.x+latest.player2.x)/2,y:(latest.player1.y+latest.player2.y)/2,rim:false});
  (["player1","player2"] as const).forEach((side,i)=>{
    const threshold = 105-(radii[i] ?? 0)-2;
    if (Math.hypot(latest[side].x,latest[side].y)>=threshold && Math.hypot(previous[side].x,previous[side].y)<threshold) { const angle=Math.atan2(latest[side].y,latest[side].x);result.push({id:`rim-${side}-${latest.sequence}`,x:Math.cos(angle)*105,y:Math.sin(angle)*105,rim:true}); }
  });
  return result;
}
