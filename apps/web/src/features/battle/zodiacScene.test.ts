import { describe, expect, it } from "vitest";
import { cinematicPhase, cinematicProgress, zodiacNumber, ZODIAC_NAMES, contactSparks, presentationSample } from "./zodiacScene";
import type { ArenaFrame } from "./BattleArena";
describe("60 second cinematic boundaries",()=>{
  it("keeps the result hidden until the full minute",()=>{ expect(cinematicPhase(47999)).toBe("battle");expect(cinematicPhase(48000)).toBe("summon");expect(cinematicPhase(53999)).toBe("summon");expect(cinematicPhase(54000)).toBe("strike");expect(cinematicPhase(59999)).toBe("strike");expect(cinematicPhase(60000)).toBe("result"); });
  it("clamps the final approach",()=>{expect(cinematicProgress(48000)).toBe(0);expect(cinematicProgress(57000)).toBe(.5);expect(cinematicProgress(90000)).toBe(1);});
  it("selects every beast and safely wraps indices",()=>{expect(new Set(ZODIAC_NAMES).size).toBe(12);expect(zodiacNumber(-1)).toBe(11);expect(zodiacNumber(12)).toBe(0);expect(zodiacNumber(NaN)).toBe(0);});
});
describe("geometry aware contact effects",()=>{
  const frame=(sequence:number,x:number,other:number):ArenaFrame=>({sequence,tick:sequence,player1:{x,y:0,angle:0,angularSpeed:10},player2:{x:other,y:0,angle:0,angularSpeed:10}});
  it("uses actual radii for a contact entry and does not repeat sustained contact",()=>{expect(contactSparks(frame(1,-30,30),frame(2,-19,19),[20,20])).toHaveLength(1);expect(contactSparks(frame(2,-19,19),frame(3,-18,18),[20,20])).toHaveLength(0);expect(contactSparks(frame(1,-30,30),frame(2,-19,19),[10,10])).toHaveLength(0);});
  it("places rim sparks at the 105 mm engine wall",()=>{const events=contactSparks(frame(1,80,-30),frame(2,85,-30),[20,20]);expect(events).toHaveLength(1);expect(events[0]).toMatchObject({rim:true,x:105,y:0});});
  it("interpolates buffered future frames only at their presentation time",()=>{
    const timed=(sequence:number,time:number):ArenaFrame=>({...frame(sequence,sequence*10,0),presentation:{startsAtMs:1000,durationMs:60000,elapsedMs:time,zodiacIndex:0,skillName:"test"}});
    const frames=[timed(1,100),timed(2,200),timed(3,300)];
    expect(presentationSample(frames,150)).toMatchObject({previous:{sequence:1},latest:{sequence:2},mix:.5});
    expect(presentationSample(frames,0)).toMatchObject({previous:{sequence:1},latest:{sequence:1},mix:1});
    expect(presentationSample(frames,400)).toMatchObject({previous:{sequence:3},latest:{sequence:3},mix:1});
    expect(presentationSample([frame(1,0,0),frame(2,1,0)],150)).toMatchObject({latest:{sequence:2},mix:1});
  });
});
