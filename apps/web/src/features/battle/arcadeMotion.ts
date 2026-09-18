/** Deterministic presentation choreography. Never used for scoring or physics. */
export const IMPACT_CYCLE_MS = 2200;
export function impactState(elapsedMs: number) {
  const cycle = Math.floor(Math.max(0,elapsedMs)/IMPACT_CYCLE_MS);
  const ageMs = Math.max(0,elapsedMs)%IMPACT_CYCLE_MS-1100;
  return { cycle, ageMs, active: ageMs>=0 && ageMs<450 };
}
export function arcadePose(elapsedMs: number, radii: readonly number[]) {
  const t=Math.max(0,elapsedMs);
  const u=(t%IMPACT_CYCLE_MS)/IMPACT_CYCLE_MS;
  const angle=t/IMPACT_CYCLE_MS*.93+Math.sin(u*Math.PI*2)*.28;
  // Smooth approach, contact at half-cycle, then a fast elastic recoil.
  const gap=32*Math.pow(Math.abs(Math.cos(u*Math.PI)),.65);
  const separation=(radii[0]??25)+(radii[1]??25)+gap;
  return ([0,1] as const).map(i=>{
    const sign=i===0?-1:1;
    const radius=(i===0?(radii[0]??25):(radii[1]??25))+gap/2;
    return {x:Math.cos(angle)*radius*sign,y:Math.sin(angle)*radius*sign,
      angle:t*.045*(i===0?1:-1), separation};
  }) as [{x:number;y:number;angle:number;separation:number},{x:number;y:number;angle:number;separation:number}];
}
export function shatterProgress(elapsedMs:number,winner:"player1"|"player2"|"draw"|undefined,side:"player1"|"player2") {
  if (!winner || winner==="draw" || winner===side) return 0;
  return Math.max(0,Math.min(1,(elapsedMs-29100)/900));
}
