import {execFileSync} from "node:child_process";
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach,describe,expect,it} from "vitest";

const roots:string[]=[];afterEach(()=>{while(roots.length)rmSync(roots.pop()!,{recursive:true,force:true})});
const sha="a".repeat(40),digest="b".repeat(64),nonce="c".repeat(64),env="production-first-deploy-e2e-9-1",repo="school/steam-top";
const row=(id:number,overrides:Record<string,unknown>={})=>({id,environment:env,created_at:`2026-01-01T00:00:0${id}Z`,payload:{schemaVersion:4,purpose:"production",authorizationRunId:"9",authorizationRunAttempt:1,authorizationWorkflowSha:sha,authorizationWorkflowRef:"refs/heads/main",sourceWorkflow:`${repo}/.github/workflows/ci.yml`,sourceEvent:"push",sourceRef:"refs/tags/v1",runId:8,commit:sha,sourceHeadSha:sha,manifestSha256:digest,nonce,...overrides}});
function candidates(rows:unknown[]){const root=mkdtempSync(join(tmpdir(),"fallback-"));roots.push(root);const input=join(root,"rows.json"),out=join(root,"candidates.json");writeFileSync(input,JSON.stringify(rows));execFileSync(process.execPath,["scripts/classify-production-e2e-fallback.mjs","candidates",input,env,"9","1",sha,repo,out]);return {root,out,value:JSON.parse(readFileSync(out,"utf8"))}}

describe("production E2E orphan fallback",()=>{
  it("distinguishes zero, one, duplicate and forged candidates without truncation",()=>{expect(candidates([]).value).toEqual({matches:[],unmatched:[]});expect(candidates([row(1)]).value.matches).toEqual(["1"]);expect(candidates([row(2),row(1)]).value.matches).toEqual(["1","2"]);expect(candidates([row(1,{sourceEvent:"pull_request"})]).value).toEqual({matches:[],unmatched:["1"]})});
  it("classifies exact prior error as idempotent and every opposite/multiple terminal as conflict",()=>{const c=candidates([row(1)]),dir=join(c.root,"statuses");mkdirSync(dir);const out=join(c.root,"plan.json"),run=(statuses:unknown[])=>{writeFileSync(join(dir,"1.json"),JSON.stringify([statuses]));execFileSync(process.execPath,["scripts/classify-production-e2e-fallback.mjs","statuses",c.out,dir,"orphaned-run:9:1",out]);return JSON.parse(readFileSync(out,"utf8"))};expect(run([]).pending).toEqual(["1"]);expect(run([{state:"error",description:"orphaned-run:9:1"}]).idempotent).toEqual(["1"]);expect(run([{state:"success",description:"x"}]).conflicts).toEqual(["1"]);expect(run([{state:"error",description:"orphaned-run:9:1"},{state:"error",description:"orphaned-run:9:1"}]).conflicts).toEqual(["1"])});
});
