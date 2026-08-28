import type { TopDesign } from "@steam-top/domain";
import { useEffect, useMemo, useState } from "react";
import { layerPath } from "../designer/previewGeometry";

export type ArenaFrame = Readonly<{ sequence: number; tick: number; player1: Readonly<{ x: number; y: number; angle: number; angularSpeed: number }>; player2: Readonly<{ x: number; y: number; angle: number; angularSpeed: number }> }>;

export function BattleArena({ designs, frames, reducedMotion = false }: Readonly<{ designs: readonly [TopDesign, TopDesign]; frames: readonly ArenaFrame[]; reducedMotion?: boolean }>) {
  const latest = frames.at(-1);
  const previous = frames.at(-2) ?? latest;
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
  const body = (side: "player1" | "player2") => {
    const a = previous?.[side] ?? { x: 0, y: 0, angle: 0, angularSpeed: 0 };
    const b = latest?.[side] ?? a;
    return { x: a.x + (b.x - a.x) * mix, y: a.y + (b.y - a.y) * mix, angle: a.angle + (b.angle - a.angle) * mix };
  };
  const p1 = body("player1"), p2 = body("player2");
  const paths = useMemo(() => designs.map((design) => [...design.layers].reverse().map((layer) => ({ ...layer, path: layerPath(layer) }))), [designs]);
  return (
    <section className="battle-arena-panel" aria-labelledby="arena-heading">
      <h3 id="arena-heading">對戰場</h3>
      <svg className="battle-arena" viewBox="-105 -105 210 210" role="img" aria-label="兩個自訂陀螺的即時對戰">
        <circle cx="0" cy="0" r="100" className="arena-ring" />
        {([p1, p2] as const).map((position, index) => <g key={index} data-testid={`battle-player${index + 1}`} transform={`translate(${position.x} ${position.y}) rotate(${position.angle * 180 / Math.PI}) scale(.72)`}>
          {paths[index]!.map((layer) => <path key={layer.id} d={layer.path} fill={layer.color} fillOpacity=".68" stroke={layer.color} strokeWidth="1" />)}
          <circle r="2.5" fill="#172033" />
        </g>)}
      </svg>
      <p role="status" className="sr-only">{latest ? `戰況已更新至第 ${latest.tick} tick` : "等待戰況資料"}</p>
    </section>
  );
}
