import type { TopDesign } from "@steam-top/domain";

/** Bounded, deterministic geometry: no random client-only event timing. */
export function ElectricImpact({ ageMs, reducedMotion }: { ageMs:number; reducedMotion:boolean }) {
  if (reducedMotion || ageMs<0 || ageMs>450) return null;
  const fade=1-ageMs/450, expansion=ageMs/180;
  return <group position={[0,.5,0]}>
    <pointLight color="#8defff" intensity={14*fade} distance={6}/>
    {Array.from({length:24},(_,i)=>{
      const a=i*Math.PI*2/24, r=.2+expansion*(1+i%3*.2);
      return <mesh key={i} position={[Math.cos(a)*r,Math.sin(i*2.3)*expansion*.45,Math.sin(a)*r]} rotation={[a,i,a]} scale={fade}>
        <boxGeometry args={[.045,.045,.28+i%3*.1]}/><meshBasicMaterial color={i%3 ? "#ffdf81" : "#ffffff"}/>
      </mesh>;
    })}
    {Array.from({length:6},(_,ray)=>Array.from({length:5},(_,step)=>{
      const a=ray*Math.PI/3, r=.2+step*.38;
      return <mesh key={`${ray}-${step}`} position={[Math.cos(a)*r,.05+((step%2)*2-1)*.15,Math.sin(a)*r]} rotation={[0,Math.PI/2-a,((step%2)*2-1)*.5]}>
        <boxGeometry args={[.48,.035,.035]}/><meshBasicMaterial color="#71efff" transparent opacity={fade} depthWrite={false}/>
      </mesh>;
    }))}
    <mesh rotation={[-Math.PI/2,0,0]}><ringGeometry args={[.1+expansion,.17+expansion,48]}/><meshBasicMaterial color="#a4faff" transparent opacity={fade} depthWrite={false}/></mesh>
  </group>;
}

export function ShatteredTop({ design, progress, x, z, reducedMotion }: {design:TopDesign;progress:number;x:number;z:number;reducedMotion:boolean}) {
  if (progress<=0) return null;
  const travel=reducedMotion ? .3 : progress;
  return <group position={[x,.25,z]}>
    {Array.from({length:36},(_,i)=>{
      const a=i*2.399963, r=(.35+(i%5)*.3)*travel;
      return <mesh key={i} position={[Math.cos(a)*r, Math.max(-.15,Math.sin(Math.PI*travel)*(.4+(i%7)*.16)-travel*.2),Math.sin(a)*r]} rotation={[travel*i,travel*i*.7,a]}>
        <tetrahedronGeometry args={[.12+(i%4)*.055]}/><meshStandardMaterial color={design.layers[i%3]!.color} metalness={.35} roughness={.3}/>
      </mesh>;
    })}
  </group>;
}
