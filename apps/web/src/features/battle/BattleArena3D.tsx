import { Canvas, useFrame } from "@react-three/fiber";
import { MATERIALS, type TopDesign } from "@steam-top/domain";
import { Component, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ExtrudeGeometry, type Group, Vector3 } from "three";
import { canUseWebGL, WebGLContextLossHandler } from "../designer/TopPreview3D";
import { makeAcrylicShape, makeSolidMetalDiscGeometry } from "../designer/preview3DGeometry";
import { BattleArena, type ArenaFrame } from "./BattleArena";
import { ZodiacBeast3D } from "./ZodiacBeast3D";
import { cinematicPhase, cinematicProgress, zodiacNumber, ZODIAC_NAMES, contactSparks, designRadiusMm, presentationSample, type ContactSpark } from "./zodiacScene";
import "./BattleArena3D.css";

export type BattleArena3DProps = Readonly<{ designs: readonly [TopDesign, TopDesign]; frames: readonly ArenaFrame[]; elapsedMs: number; winner?: "player1" | "player2" | "draw" | undefined; zodiacIndex: number; skillName: string; reducedMotion?: boolean }>;
class SceneBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}
function AcrylicTop({ design }: { design: TopDesign }) {
  const geometries = useMemo(() => design.layers.map(layer => new ExtrudeGeometry(makeAcrylicShape(layer, design), { depth: MATERIALS.layerThicknessMm, bevelEnabled: false, curveSegments: 16 })), [design]);
  const disc = useMemo(() => makeSolidMetalDiscGeometry(design.metalDiscDiameterMm), [design.metalDiscDiameterMm]);
  useEffect(() => () => { geometries.forEach(g => g.dispose()); }, [geometries]);
  useEffect(() => () => disc.dispose(), [disc]);
  return <group rotation={[-Math.PI / 2, 0, 0]} scale={.05}>
    {design.layers.map((layer, i) => <mesh key={layer.id} geometry={geometries[i]!} position={[0, 0, (layer.position === "top" ? 2 : layer.position === "middle" ? 1 : 0) * MATERIALS.layerThicknessMm]}><meshPhysicalMaterial color={layer.color} metalness={.12} roughness={.17} transparent opacity={.85} clearcoat={1} side={2} /></mesh>)}
    {design.metalDiscDiameterMm > 0 && <mesh geometry={disc} rotation={[Math.PI / 2,0,0]} position={[0,0,-MATERIALS.metalDiscThicknessMm/2]}><meshStandardMaterial color="#aabbd3" metalness={.85} roughness={.2} /></mesh>}
    <mesh position={[0,0,-5]} rotation={[Math.PI/2,0,0]}><coneGeometry args={[3,8,12]} /><meshStandardMaterial color="#d7e7ff" metalness={.8} roughness={.2}/></mesh>
  </group>;
}
function SparkBurst({ event }: { event: ContactSpark }) {
  const group = useRef<Group>(null), age = useRef(0);
  useFrame((_,delta)=>{ age.current += delta; if (!group.current) return; group.current.visible=age.current<.55; group.current.children.forEach((child,i)=>{const a=i*Math.PI*2/12;const t=age.current;child.position.set(Math.cos(a)*t*3,t*2-t*t*4,Math.sin(a)*t*3);child.scale.setScalar(Math.max(0,1-t/.55));}); });
  return <group ref={group} position={[event.x*.05,.3,event.y*.05]}>{Array.from({length:12},(_,i)=><mesh key={i}><octahedronGeometry args={[.075]}/><meshBasicMaterial color={event.rim ? "#5eeaff" : "#ffe499"}/></mesh>)}</group>;
}
function Scene(props: BattleArena3DProps) {
  const top1 = useRef<Group>(null), top2 = useRef<Group>(null), beast = useRef<Group>(null), sparks = useRef<Group>(null);
  const phase = cinematicPhase(props.elapsedMs);
  const { latest, previous, mix } = presentationSample(props.frames, props.elapsedMs);
  const playedFrames = props.frames.filter(frame => !frame.presentation || frame.presentation.elapsedMs <= props.elapsedMs);
  const effectsLatest = playedFrames.at(-1), effectsPrevious = playedFrames.at(-2);
  const target = useMemo(() => new Vector3(), []);
  const look = useMemo(() => new Vector3(), []);
  const radii = useMemo(()=>props.designs.map(designRadiusMm),[props.designs]);
  const [bursts,setBursts] = useState<ContactSpark[]>([]);
  useEffect(()=>{
    if (props.reducedMotion || phase !== "battle") { setBursts([]); return; }
    const events=contactSparks(effectsPrevious,effectsLatest,radii); if (!events.length) return;
    setBursts(old=>[...old,...events].slice(-8));
    const timer=setTimeout(()=>setBursts(old=>old.filter(e=>!events.some(n=>n.id===e.id))),600);
    return ()=>clearTimeout(timer);
  },[effectsLatest,effectsPrevious,radii,phase,props.reducedMotion]);
  useFrame(({ camera }) => {
    if (phase === "result") return;
    const seconds = Math.max(0,props.elapsedMs)/1000;
    [top1, top2].forEach((ref, i) => {
      const object = ref.current; if (!object) return;
      const side = i === 0 ? "player1" : "player2";
      const a = previous?.[side], b = latest?.[side];
      let x = a && b ? (a.x + (b.x-a.x)*mix)*.05 : (i === 0 ? -2 : 2);
      let z = a && b ? (a.y + (b.y-a.y)*mix)*.05 : 0;
      const progress = cinematicProgress(props.elapsedMs);
      if (phase === "strike") {
        const approach = Math.min(1, Math.max(0, (progress-.35)/.4));
        x = x*(1-approach)+(i === 0 ? -.4 : .4)*approach; z *= 1-approach;
        const recoil = Math.max(0, (progress-.8)/.2);
        if (props.winner !== "draw" && props.winner !== undefined && props.winner !== side) { x += (i === 0 ? -1 : 1)*recoil*2; z += recoil; }
      }
      object.position.set(x,.25,z);
      object.rotation.y = props.reducedMotion ? 0 : (a?.angle ?? 0) + ((b?.angle ?? 0)-(a?.angle ?? 0))*mix;
    });
    if (beast.current) {
      const lunge = phase === "strike" ? Math.min(1, Math.max(0,(cinematicProgress(props.elapsedMs)-.45)/.35)) : 0;
      beast.current.rotation.y = props.reducedMotion ? -.5 : -.5 + Math.sin(seconds*.65)*.2;
      beast.current.rotation.z = props.reducedMotion ? 0 : -lunge*.55;
      beast.current.position.set(props.reducedMotion ? 0 : lunge*1.5,props.reducedMotion ? .7 : .7+Math.sin(seconds*2)*.12-lunge*.45,-1+(props.reducedMotion ? 0 : lunge*1.4));
    }
    if (sparks.current) sparks.current.rotation.y = props.reducedMotion ? 0 : seconds*.5;
    if (props.reducedMotion) { target.set(8,10,12); look.set(0,0,0); }
    else if (phase === "summon") { target.set(6,4.5,8); look.set(0,1.6,0); }
    else if (phase === "strike") { target.set(3,2.3,5); look.set(0,.5,0); }
    else { const t = seconds*.055; target.set(Math.sin(t)*3+7,9,Math.cos(t)*2+9); const a=top1.current?.position,b=top2.current?.position; look.set(a && b ? (a.x+b.x)*.15 : 0,0,a && b ? (a.z+b.z)*.15 : 0); }
    camera.position.copy(target); camera.lookAt(look);
  });
  return <>
    <color attach="background" args={["#050b1c"]} /><fog attach="fog" args={["#050b1c",18,35]} />
    <ambientLight intensity={1.3}/><directionalLight position={[3,10,5]} intensity={3} color="#c9e8ff"/><pointLight position={[-5,3,-3]} intensity={35} color="#2ce5ff"/><pointLight position={[5,4,3]} intensity={40} color="#ff558d"/>
    <mesh position={[0,-.3,0]}><cylinderGeometry args={[5.4,5.7,.5,96]}/><meshStandardMaterial color="#152440" metalness={.75} roughness={.35}/></mesh>
    {[5.1,4.2,2.8].map((r,i) => <mesh key={r} rotation={[Math.PI/2,0,0]} position={[0,-.025,0]}><torusGeometry args={[r,.025,8,96]}/><meshStandardMaterial color={i === 0 ? "#58ecff" : "#375b9e"} emissive={i === 0 ? "#26c8ff" : "#2e4388"} emissiveIntensity={2}/></mesh>)}
    {Array.from({length:24},(_,i)=><mesh key={i} position={[Math.cos(i*Math.PI/12)*5.3,.05,Math.sin(i*Math.PI/12)*5.3]} rotation={[0,-i*Math.PI/12,0]}><boxGeometry args={[.2,.1,.04]}/><meshStandardMaterial color="#fff1b5" emissive="#ffd883" emissiveIntensity={2}/></mesh>)}
    {[top1,top2].map((ref,i)=><group key={i} ref={ref}><AcrylicTop design={props.designs[i]!}/><mesh rotation={[-Math.PI/2,0,0]} position={[0,-.18,0]}><ringGeometry args={[.7,.77,48]}/><meshBasicMaterial color={i === 0 ? "#39ddff" : "#ff698e"} transparent opacity={.7}/></mesh>{!props.reducedMotion && phase !== "result" && [0,1,2].map(j=><mesh key={j} rotation={[-Math.PI/2,0,j*2.1]} position={[0,.12+j*.01,0]}><ringGeometry args={[(radii[i] ?? 20)*.05,(radii[i] ?? 20)*.05+.12,24,1,0,1.3]}/><meshBasicMaterial color={i === 0 ? "#69ecff" : "#ff92b9"} transparent opacity={.55-j*.12} depthWrite={false}/></mesh>)}</group>)}
    {phase === "battle" && bursts.map(event=><SparkBurst key={event.id} event={event}/>)}
    {!props.reducedMotion && playedFrames.slice(-7,-1).flatMap((frame,i)=>(["player1","player2"] as const).map((side,j)=><mesh key={`${frame.sequence}-${side}`} position={[frame[side].x*.05,.025,frame[side].y*.05]} rotation={[-Math.PI/2,0,0]}><ringGeometry args={[.45,.6,24]}/><meshBasicMaterial color={j === 0 ? "#35dfff" : "#ff5985"} transparent opacity={(i+1)*.055} depthWrite={false}/></mesh>))}
    {(phase === "summon" || phase === "strike") && <group ref={beast} position={[0,.7,-1]} scale={phase === "strike" ? .85 : 1.35}><ZodiacBeast3D index={props.zodiacIndex} color={props.winner === "player2" ? "#ff88b7" : "#52d9ef"}/></group>}
    {!props.reducedMotion && phase === "strike" && cinematicProgress(props.elapsedMs) > .78 && <group>{[0,1,2].map(i => <mesh key={i} rotation={[-Math.PI/2,0,0]} position={[0,.15+i*.12,0]}><ringGeometry args={[(cinematicProgress(props.elapsedMs)-.78)*16+i*.2,(cinematicProgress(props.elapsedMs)-.78)*16+.1+i*.2,64]}/><meshBasicMaterial color={i === 1 ? "#ffffff" : "#ffd37a"} transparent opacity={.8} depthWrite={false}/></mesh>)}</group>}
    {!props.reducedMotion && (phase === "summon" || phase === "strike") && <group ref={sparks}>{Array.from({length:36},(_,i)=><mesh key={i} position={[Math.sin(i*2.4)*(1+i%4), .4+(i%7)*.5,Math.cos(i*2.4)*(1+i%4)]}><octahedronGeometry args={[.025+(i%3)*.02]}/><meshBasicMaterial color={i%2 ? "#7ef7ff" : "#ffe0a0"}/></mesh>)}</group>}
  </>;
}
export function BattleArena3D(props: BattleArena3DProps) {
  const [supported,setSupported] = useState(canUseWebGL);
  const phase = cinematicPhase(props.elapsedMs);
  const fallback = <><p role="status">此裝置未能啟用 3D，改以平面對戰顯示。</p><BattleArena designs={props.designs} frames={props.frames} winner={phase === "result" ? props.winner : undefined} reducedMotion={props.reducedMotion ?? false}/></>;
  return <section className="cinema-arena" data-testid="battle-arena-3d" data-phase={phase} aria-label="生肖神獸 3D 對戰場">
    <div className="cinema-hud"><span>生肖競技場 · 3D</span><span>{Math.max(0,60-Math.floor(props.elapsedMs/1000))} 秒</span></div>
    {supported ? <SceneBoundary fallback={fallback}><div className="cinema-viewport"><Canvas dpr={[1,1.5]} camera={{position:[8,10,12],fov:44}} gl={{antialias:true,alpha:false}}><WebGLContextLossHandler onContextLost={()=>setSupported(false)}/><Scene {...props}/></Canvas></div></SceneBoundary> : fallback}
    {(phase === "summon" || phase === "strike") && <div className="cinema-skill" role="status"><span>{ZODIAC_NAMES[zodiacNumber(props.zodiacIndex)]}之守護靈 · {phase === "summon" ? "神獸覺醒" : "終極一擊"}</span><strong>{props.skillName}</strong></div>}
    {phase === "result" && props.winner && <div className="cinema-result" data-testid="arena-victory" role="status"><strong>{props.winner === "draw" ? "平手" : props.winner === "player1" ? "玩家一勝出" : "玩家二勝出"}</strong><span>回合完結</span></div>}
  </section>;
}
