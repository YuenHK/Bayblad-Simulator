import fs from "node:fs";

const [mode,...args]=process.argv.slice(2);
if(mode==="candidates"){
  const [input,environment,run,attempt,head,repo,out]=args,rows=JSON.parse(fs.readFileSync(input,"utf8")).flat(),matches=[],unmatched=[];
  for(const d of rows){let p;try{p=typeof d.payload==="string"?JSON.parse(d.payload):d.payload}catch{unmatched.push(String(d.id));continue}const ok=d.environment===environment&&p?.schemaVersion===4&&p.purpose==="production"&&String(p.authorizationRunId)===run&&String(p.authorizationRunAttempt)===attempt&&p.authorizationWorkflowSha===head&&p.authorizationWorkflowRef?.startsWith("refs/heads/")&&p.sourceWorkflow===`${repo}/.github/workflows/ci.yml`&&p.sourceEvent==="push"&&p.sourceRef?.startsWith("refs/tags/v")&&/^[1-9][0-9]*$/.test(String(p.runId))&&/^[a-f0-9]{40}$/.test(p.commit)&&p.commit===p.sourceHeadSha&&/^[a-f0-9]{64}$/.test(p.manifestSha256)&&/^[a-f0-9]{64}$/.test(p.nonce)&&/^[1-9][0-9]*$/.test(String(d.id))&&Number.isFinite(Date.parse(d.created_at));(ok?matches:unmatched).push(ok?d:String(d.id))}
  matches.sort((a,b)=>Date.parse(a.created_at)-Date.parse(b.created_at)||Number(a.id)-Number(b.id));fs.writeFileSync(out,JSON.stringify({matches:matches.map(x=>String(x.id)),unmatched})+"\n");
}else if(mode==="statuses"){
  const [candidateFile,dir,want,out]=args,{matches}=JSON.parse(fs.readFileSync(candidateFile,"utf8")),plan={pending:[],idempotent:[],conflicts:[]};
  for(const id of matches){const terminal=JSON.parse(fs.readFileSync(`${dir}/${id}.json`,"utf8")).flat().filter(x=>["success","failure","error","inactive"].includes(x.state));if(!terminal.length)plan.pending.push(id);else if(terminal.length===1&&terminal[0].state==="error"&&terminal[0].description===want)plan.idempotent.push(id);else plan.conflicts.push(id)}fs.writeFileSync(out,JSON.stringify(plan)+"\n");
}else throw new Error("usage: classify-production-e2e-fallback.mjs candidates|statuses ...");
