import { useEffect, useRef, useState } from "react";
import type { TopDesign } from "@steam-top/domain";
import type { ArenaFrame } from "./BattleArena";
import { BattleArena3D } from "./BattleArena3D";
import type { GameAudio } from "../game/GameAudio";
import { impactState } from "./arcadeMotion";

export function CinematicBattle({ designs, frames, clockOffsetMs, reducedMotion, gameAudio }: { designs: readonly [TopDesign, TopDesign]; frames: readonly ArenaFrame[]; clockOffsetMs: number; reducedMotion: boolean; gameAudio?: GameAudio | undefined }) {
  const presentation = frames.at(-1)!.presentation!;
  const [now, setNow] = useState(Date.now());
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => { panel.current?.scrollIntoView?.({ block: "center", behavior: "smooth" }); }, [presentation.startsAtMs]);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 33); return () => clearInterval(timer); }, []);
  const elapsedMs = Math.max(0, Math.min(presentation.durationMs, now + clockOffsetMs - presentation.startsAtMs));
  const stage = elapsedMs >= presentation.durationMs ? "end" : elapsedMs >= presentation.durationMs * .9 ? "strike" : elapsedMs >= presentation.durationMs * .8 ? "summon" : "battle";
  useEffect(() => {
    const impact = impactState(elapsedMs * 30000 / presentation.durationMs);
    if (stage === "battle" && impact.active) gameAudio?.play("impact", `${presentation.startsAtMs}-arcade-${impact.cycle}`);
    if (stage === "summon") gameAudio?.play("launch", `${presentation.startsAtMs}-summon`);
    if (stage === "end") gameAudio?.play("victory", `${presentation.startsAtMs}-end`);
  }, [stage, elapsedMs, presentation.startsAtMs, presentation.durationMs, gameAudio]);
  useEffect(() => {
    if (elapsedMs >= presentation.durationMs * .97) gameAudio?.play("heavy-impact", `${presentation.startsAtMs}-strike`);
  }, [elapsedMs, gameAudio, presentation.startsAtMs, presentation.durationMs]);
  return <div ref={panel} data-testid="cinematic-battle" data-elapsed-ms={Math.round(elapsedMs)}>
    <BattleArena3D designs={designs} frames={frames} elapsedMs={elapsedMs * 30000 / presentation.durationMs} displayDurationMs={presentation.durationMs} {...(presentation.finisher ? { winner: presentation.finisher } : {})} zodiacIndex={presentation.zodiacIndex} skillName={presentation.skillName} reducedMotion={reducedMotion} />
  </div>;
}
