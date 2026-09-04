import type { TopDesign } from "@steam-top/domain";
import { useEffect, useMemo, useRef, useState } from "react";
import { layerPath } from "../designer/previewGeometry";
import { deriveBattleEffects, type BattleEffect } from "./battleEffects";

export type ArenaFrame = Readonly<{ sequence: number; tick: number; player1: Readonly<{ x: number; y: number; angle: number; angularSpeed: number }>; player2: Readonly<{ x: number; y: number; angle: number; angularSpeed: number }> }>;

export function BattleArena({ designs, frames, winner, reducedMotion = false, quality = "auto", onEffect }: Readonly<{ designs: readonly [TopDesign, TopDesign]; frames: readonly ArenaFrame[]; winner?: "player1" | "player2" | "draw" | undefined; reducedMotion?: boolean; quality?: "auto" | "reduced"; onEffect?: (effect: BattleEffect) => void }>) {
  const latest = frames.at(-1);
  const previous = frames.at(-2) ?? latest;
  const panelRef = useRef<HTMLElement>(null);
  const focused = useRef(false);
  const [mix, setMix] = useState(reducedMotion ? 1 : 0);
  useEffect(() => {
    if (reducedMotion || !latest) { setMix(1); return; }
    setMix(0);
    const started = performance.now();
    let handle = 0;
    const animate = (time: number) => { const next = Math.min(1, (time - started) / 67); setMix(next); if (next < 1) handle = requestAnimationFrame(animate); };
    handle = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(handle);
  }, [latest?.sequence, reducedMotion]);
  useEffect(() => {
    if (!latest || focused.current) return;
    focused.current = true;
    panelRef.current?.scrollIntoView?.({ behavior: reducedMotion ? "auto" : "smooth", block: "center" });
  }, [latest, reducedMotion]);
  const body = (side: "player1" | "player2") => {
    const a = previous?.[side] ?? { x: 0, y: 0, angle: 0, angularSpeed: 0 };
    const b = latest?.[side] ?? a;
    return { x: a.x + (b.x - a.x) * mix, y: a.y + (b.y - a.y) * mix, angle: a.angle + (b.angle - a.angle) * mix };
  };
  const p1 = body("player1"), p2 = body("player2");
  const paths = useMemo(() => designs.map((design) => [...design.layers].reverse().map((layer) => ({ ...layer, path: layerPath(layer) }))), [designs]);
  const effects = useMemo(() => {
    if (reducedMotion) return [];
    const recent = frames.slice(-9);
    const remembered = new Map<string, BattleEffect>();
    for (let index = 1; index < recent.length; index += 1) {
      for (const effect of deriveBattleEffects(recent[index - 1], recent[index])) remembered.set(effect.id, effect);
    }
    return [...remembered.values()];
  }, [frames, reducedMotion]);
  useEffect(() => { for (const effect of effects) onEffect?.(effect); }, [effects, onEffect]);
  const sparkCount = quality === "reduced" ? 5 : 10;
  return (
    <section ref={panelRef} className={`battle-arena-panel${winner ? " has-winner" : ""}`} aria-labelledby="arena-heading">
      <h3 id="arena-heading">對戰場</h3>
      <div className="battle-live-indicator" aria-hidden="true"><i /> 即時對戰</div>
      <svg className="battle-arena" viewBox="-105 -105 210 210" aria-hidden="true">
        <defs><radialGradient id="arenaFloor" cx="50%" cy="45%"><stop offset="0" stopColor="#163c68" /><stop offset=".58" stopColor="#0b1833" /><stop offset="1" stopColor="#030711" /></radialGradient><filter id="topGlow"><feGaussianBlur stdDeviation="2.5" result="blur" /><feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge></filter></defs>
        <circle cx="0" cy="0" r="100" className="arena-floor" />
        <circle cx="0" cy="0" r="100" className="arena-ring" />
        <circle cx="0" cy="0" r="82" className="arena-energy-ring" /><circle cx="0" cy="0" r="56" className="arena-energy-ring inner" />
        <g className="arena-grid"><path d="M-92 0H92M0-92V92M-65-65L65 65M65-65L-65 65" /></g>
        <g className="top-afterimages">{frames.slice(-5, -1).flatMap((frame, frameIndex, trailFrames) => (["player1", "player2"] as const).map((side, sideIndex) => <circle key={`${frame.sequence}-${side}`} className={`top-afterimage trail-${sideIndex + 1}`} cx={frame[side].x} cy={frame[side].y} r={5 + Math.abs(frame[side].angularSpeed) / 5} opacity={(frameIndex + 1) / (trailFrames.length + 1) * .38} />))}</g>
        {([p1, p2] as const).map((position, index) => <g key={index}><circle className={`top-trail trail-${index + 1}`} cx={position.x} cy={position.y} r={Math.min(15, 6 + Math.abs(latest?.[index === 0 ? "player1" : "player2"].angularSpeed ?? 0) / 4)} /><g filter="url(#topGlow)" data-testid={`battle-player${index + 1}`} transform={`translate(${position.x} ${position.y}) rotate(${position.angle * 180 / Math.PI}) scale(.72)`}>
          {paths[index]!.map((layer) => <path key={layer.id} d={layer.path} fill={layer.color} fillOpacity=".68" stroke={layer.color} strokeWidth="1" />)}
          <circle r="2.5" fill="#172033" />
        </g></g>)}
        <g className="battle-effects-layer">{effects.map((effect) => <g key={effect.id} data-effect-id={effect.id} className={`battle-effect effect-${effect.type}`} transform={`translate(${effect.x} ${effect.y})`}><circle r={effect.type === "heavy-impact" ? 18 : 10} /><g className="spark-burst">{Array.from({ length: sparkCount }, (_, index) => { const angle = index * 360 / sparkCount; const length = (effect.type === "heavy-impact" ? 18 : 11) * (.65 + (index % 3) * .14); return <line key={index} x1="5" y1="0" x2={length} y2="0" transform={`rotate(${angle})`} />; })}</g></g>)}</g>
      </svg>
      {winner ? <div className={`arena-victory victory-${winner}`} data-testid="arena-victory" role="status"><span>{winner === "draw" ? "再戰一輪" : "K.O."}</span><strong>{winner === "draw" ? "平手" : winner === "player1" ? "玩家一勝出" : "玩家二勝出"}</strong></div> : null}
      <p className="sr-only">{latest ? "對戰進行中" : "等待戰況資料"}</p>
    </section>
  );
}
