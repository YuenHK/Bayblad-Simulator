import { useEffect, useRef, useState } from "react";
import type { TopDesign } from "@steam-top/domain";
import type { ArenaFrame } from "./BattleArena";
import { BattleArena3D } from "./BattleArena3D";
import type { GameAudio } from "../game/GameAudio";
import { contactSparks, designRadiusMm } from "./zodiacScene";

export function CinematicBattle({ designs, frames, clockOffsetMs, reducedMotion, gameAudio }: { designs: readonly [TopDesign, TopDesign]; frames: readonly ArenaFrame[]; clockOffsetMs: number; reducedMotion: boolean; gameAudio?: GameAudio | undefined }) {
  const presentation = frames.at(-1)!.presentation!;
  const [now, setNow] = useState(Date.now());
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => { panel.current?.scrollIntoView?.({ block: "center", behavior: "smooth" }); }, [presentation.startsAtMs]);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 33); return () => clearInterval(timer); }, []);
  const elapsedMs = Math.max(0, Math.min(60_000, now + clockOffsetMs - presentation.startsAtMs));
  const stage = elapsedMs >= 60_000 ? "end" : elapsedMs >= 54_000 ? "strike" : elapsedMs >= 48_000 ? "summon" : "battle";
  useEffect(() => {
    if (stage === "summon") gameAudio?.play("launch", `${presentation.startsAtMs}-summon`);
    if (stage === "end") gameAudio?.play("victory", `${presentation.startsAtMs}-end`);
  }, [stage, presentation.startsAtMs, gameAudio]);
  const played = frames.filter(frame => (frame.presentation?.elapsedMs ?? 0) <= elapsedMs);
  const latest = played.at(-1), previous = played.at(-2);
  useEffect(() => {
    if (elapsedMs >= 58_680) gameAudio?.play("heavy-impact", `${presentation.startsAtMs}-strike`);
    if (elapsedMs < 48_000) for (const spark of contactSparks(previous, latest, designs.map(designRadiusMm))) {
      gameAudio?.play(spark.rim ? "rim" : "impact", `${presentation.startsAtMs}-${spark.id}`);
    }
  }, [latest, previous, elapsedMs, designs, gameAudio, presentation.startsAtMs]);
  return <div ref={panel} data-testid="cinematic-battle" data-elapsed-ms={Math.round(elapsedMs)}>
    <BattleArena3D designs={designs} frames={frames} elapsedMs={elapsedMs} {...(presentation.finisher ? { winner: presentation.finisher } : {})} zodiacIndex={presentation.zodiacIndex} skillName={presentation.skillName} reducedMotion={reducedMotion} />
  </div>;
}
