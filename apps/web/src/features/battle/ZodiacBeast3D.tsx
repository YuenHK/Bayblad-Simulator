import { zodiacNumber } from "./zodiacScene";

type V = [number, number, number];
/** Original low-poly spirit sculpture. Shared anatomy, species-specific silhouettes. */
export function ZodiacBeast3D({ index, color }: { index: number; color: string }) {
  const n = zodiacNumber(index);
  const ball = (key: string, p: V, s: V, c = color) => <mesh key={key} position={p} scale={s}><icosahedronGeometry args={[1, 1]} /><meshStandardMaterial color={c} emissive={c} emissiveIntensity={.3} metalness={.45} roughness={.3} /></mesh>;
  const horn = (key: string, p: V, scale: V, rotation: V = [0, 0, 0], c = "#ffdf91") => <mesh key={key} position={p} scale={scale} rotation={rotation}><coneGeometry args={[1, 2, 5]} /><meshStandardMaterial color={c} emissive={c} emissiveIntensity={.35} metalness={.4} roughness={.3} /></mesh>;
  const snake = n === 5, dragon = n === 4, bird = n === 9;
  return <group>
    {snake || dragon ? Array.from({ length: 13 }, (_, i) => ball(`coil${i}`, [Math.sin(i * .65) * 1.1, .35 + i * .14, Math.cos(i * .65) * .65], [.48, .43, .43])) : ball("body", [0, .9, 0], [bird ? .62 : 1.1, .72, .58])}
    {ball("head", [snake || dragon ? Math.sin(12 * .65) * 1.1 : .85, 1.85, 0], [n === 6 ? .65 : .55, .55, .48])}
    {!snake && !dragon && !bird && [-.65, .6].flatMap((x) => [-.35, .35].map((z) => ball(`leg${x}${z}`, [x, .25, z], [.2, .55, .2])))}
    {[ -1, 1 ].map((s) => ball(`eye${s}`, [snake || dragon ? 1.42 : 1.22, 1.97, s * .36], [.1, .12, .09], "#ffffff"))}
    {n === 0 && <>{[-1, 1].map(s => ball(`mouse-ear${s}`, [.65, 2.35, s * .4], [.32, .37, .18]))}{ball("nose", [1.4, 1.7, 0], [.35, .2, .23])}{Array.from({ length: 9 }, (_, i) => ball(`tail${i}`, [-1 - i * .17, .6 + Math.sin(i * .5) * .2, .1], [.12, .1, .1], "#ffc8db"))}</>}
    {(n === 1 || dragon) && [-1, 1].map(s => horn(`horn${s}`, [.65, 2.6, s * .5], [.16, .65, .16], [s * .5, 0, -.3]))}
    {n === 2 && <>{[-1, 1].map(s => ball(`tiger-ear${s}`, [.7, 2.3, s * .4], [.22, .24, .18]))}{[-.7, -.2, .3].map((x,i) => <mesh key={i} position={[x, 1.3, 0]} rotation={[0,0,-.2]}><boxGeometry args={[.14,.65,1.02]} /><meshStandardMaterial color="#14203b" /></mesh>)}</>}
    {n === 3 && <>{[-1, 1].map(s => ball(`rabbit-ear${s}`, [.72, 2.9, s * .25], [.18, .8, .18]))}{ball("fluffy-tail", [-1.1,1,0], [.32,.32,.32], "#ffffff")}</>}
    {dragon && <>{[-1,1].map(s => horn(`wing${s}`, [0, 1.5, s * 1.15], [.3,1.15,.65], [s * 1.1,0,0]))}{[0,1,2,3].map(i => horn(`spine${i}`, [-.6 + i * .4,1.6,0],[.18,.38,.18]))}</>}
    {snake && <>{horn("fang1", [1.55,1.5,.2],[.06,.2,.06],[0,0,Math.PI])}{horn("fang2", [1.55,1.5,-.2],[.06,.2,.06],[0,0,Math.PI])}</>}
    {n === 6 && <>{ball("neck", [.6,1.5,0],[.35,.8,.4])}{ball("muzzle", [1.3,1.65,0],[.5,.3,.32])}{[0,1,2,3].map(i => horn(`mane${i}`,[.15,1.35+i*.25,0],[.25,.25,.4],[0,0,1],"#f7ce76"))}{horn("horse-tail", [-1.2,.75,0],[.25,.65,.25],[0,0,-.65])}</>}
    {n === 7 && [-1,1].map(s => <mesh key={s} position={[.7,2.12,s*.5]} rotation={[Math.PI/2,0,0]}><torusGeometry args={[.35,.13,6,14,Math.PI*1.7]} /><meshStandardMaterial color="#ffdf91" metalness={.5} roughness={.35} /></mesh>)}
    {n === 8 && <>{ball("face",[1.18,1.8,0],[.26,.4,.41],"#ffe0ab")}{[-1,1].map(s => ball(`monkey-ear${s}`,[.7,1.9,s*.55],[.25,.28,.18]))}<mesh position={[-1.15,1,0]}><torusGeometry args={[.55,.12,6,18,Math.PI*1.8]} /><meshStandardMaterial color={color} /></mesh></>}
    {bird && <>{horn("beak",[1.4,1.8,0],[.22,.4,.22],[0,0,-Math.PI/2])}{[0,1,2].map(i => ball(`comb${i}`,[.55+i*.2,2.4,0],[.14,.3,.14],"#ff557b"))}{[-1,1].map(s => ball(`wing${s}`,[-.1,1,s*.55],[.8,.35,.18]))}{[0,1,2,3].map(i => horn(`feather${i}`,[-1,1+i*.15,(i-1.5)*.2],[.16,.85,.2],[0,0,.6+i*.18]))}{[-1,1].map(s => horn(`foot${s}`,[0,.1,s*.3],[.13,.4,.13]))}</>}
    {n === 10 && <>{[-1,1].map(s => ball(`dog-ear${s}`,[.6,1.85,s*.5],[.22,.55,.18]))}{ball("dog-muzzle",[1.4,1.6,0],[.4,.27,.3])}{horn("wag-tail",[-1.1,1.25,0],[.17,.55,.17],[0,0,.6])}</>}
    {n === 11 && <>{ball("snout",[1.4,1.75,0],[.23,.28,.35],"#ffb9cf")}{[-1,1].map(s => horn(`pig-ear${s}`,[.65,2.35,s*.36],[.23,.3,.18]))}<mesh position={[-1.2,1,0]}><torusGeometry args={[.22,.08,6,12,Math.PI*1.8]} /><meshStandardMaterial color="#ffb9cf" /></mesh></>}
  </group>;
}
