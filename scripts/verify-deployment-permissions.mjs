import fs from "node:fs";
import path from "node:path";
import {execFileSync} from "node:child_process";

const root=path.resolve(process.argv[2]??".");
const allowed=new Map([
  ["authorize-release.yml",new Set(["authorize"])],
  ["reconcile-deployment.yml",new Set(["reconcile"])],
  ["reconcile-production-e2e.yml",new Set(["terminal-reconcile"])],
  ["record-deployment.yml",new Set(["deploy-record"])],
  // These are reusable implementation jobs. Their workflow_call guard is
  // mandatory; only authorize-release.yml may invoke them with this token.
  ["ci.yml",new Set(["production-first-deploy-e2e","release-host-core-integration"])],
]);
const dir=path.join(root,".github/workflows");
const ruby=`require 'yaml';require 'json';v=YAML.safe_load(File.read(ARGV[0]),aliases:true);STDOUT.write(JSON.generate(v))`;
for(const name of fs.readdirSync(dir).filter(x=>/\.ya?ml$/.test(x)).sort()){
  const file=path.join(dir,name);let doc;
  try{doc=JSON.parse(execFileSync("ruby",["-e",ruby,file],{encoding:"utf8"}))}catch(error){throw new Error(`${name}: YAML parse failed: ${error.message}`)}
  if(!Object.hasOwn(doc,"permissions"))throw new Error(`${name}: explicit top-level permissions required`);
  const top=doc.permissions;if(top==="write-all")throw new Error(`${name}: write-all forbidden`);
  if(typeof top!=="string"&&(top===null||Array.isArray(top)||typeof top!=="object"))throw new Error(`${name}: invalid top-level permissions`);
  for(const [jobName,job] of Object.entries(doc.jobs??{})){
    if(!job||typeof job!=="object"||Array.isArray(job))throw new Error(`${name}:${jobName}: invalid job`);
    const effective=Object.hasOwn(job,"permissions")?job.permissions:top;
    if(effective==="write-all")throw new Error(`${name}:${jobName}: write-all forbidden`);
    if(typeof effective!=="string"&&(effective===null||Array.isArray(effective)||typeof effective!=="object"))throw new Error(`${name}:${jobName}: invalid permissions`);
    if(JSON.stringify(effective).includes("${{"))throw new Error(`${name}:${jobName}: dynamic permissions forbidden`);
    if(typeof effective==="object"&&effective.deployments==="write"&&!allowed.get(name)?.has(jobName))throw new Error(`${name}:${jobName}: unauthorized deployments:write`);
    if(name==="ci.yml"&&typeof effective==="object"&&effective.deployments==="write"&&job.if!=="github.event_name == 'workflow_call'")throw new Error(`${name}:${jobName}: reusable deployment writer lacks exact workflow_call guard`);
    if(typeof job.uses==="string"&&job.uses.startsWith("./.github/workflows/")&&(name!=="authorize-release.yml"||jobName!=="authorize"||job.uses!=="./.github/workflows/ci.yml")){
      throw new Error(`${name}:${jobName}: unauthorized local reusable workflow caller`);
    }
  }
}
