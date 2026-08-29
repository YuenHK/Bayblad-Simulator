import { readFileSync } from "node:fs";
const [evidencePath,configPath]=process.argv.slice(2),evidence=JSON.parse(readFileSync(evidencePath,"utf8")),config=JSON.parse(readFileSync(configPath,"utf8"));
const flattened=[];const walk=(x)=>{if(typeof x==="string")flattened.push(x);else if(Array.isArray(x))x.forEach(walk);else if(x&&typeof x==="object")for(const [k,v] of Object.entries(x)){flattened.push(`${k}=${String(v)}`);walk(v)}};walk(evidence);
const workflowRef=config.workflowRef,workflowSha=config.workflowSha,workflowIdentity=config.workflowIdentity;
if(!workflowIdentity||!workflowRef?.startsWith("refs/heads/")||!/^[a-f0-9]{40}$/u.test(workflowSha)||!flattened.some(x=>x.includes(workflowIdentity))||!flattened.some(x=>x.includes(workflowRef))||!flattened.some(x=>x.includes(workflowSha)))throw new Error("attestation workflowRef/workflowSha identity mismatch");
