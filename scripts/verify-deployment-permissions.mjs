import fs from "node:fs";
import path from "node:path";
import {execFileSync} from "node:child_process";
import {createHash} from "node:crypto";

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
const exactWriterJobs=new Map([
  ["authorize-release.yml:authorize","c95172180a7781847b3c5db632a8e9710452d37d710910551d6f500e2c991210"],
  ["ci.yml:production-first-deploy-e2e","e092dd6301f178b2afc8dcc60d036fae48c4ee59ac7ee6ddc9cea07b9d7c774e"],
  ["ci.yml:release-host-core-integration","7eaa60e3069d176b9cddb1cfe74036c514c094e3231bc1622e20b0f18873655d"],
  ["reconcile-deployment.yml:reconcile","ffeb899f90803b23a2944a7733a0d89ff3b6dfc75cd86ae9743be2ed0a647f5e"],
  ["reconcile-production-e2e.yml:terminal-reconcile","e0cfe410b5b3cd89db0ee46d31c917ebe3aa59658c1600f46ba9bd0fab8ab1a8"],
  ["record-deployment.yml:deploy-record","239ec107c411321355c90edb3be37344dadbd5ae41b4bdb29b2305d5df52f126"],
]);
const authority={group:"production-deployment-status-authority","cancel-in-progress":false};
const dir=path.join(root,".github/workflows");
const ruby=`require 'yaml';require 'json';v=YAML.safe_load(File.read(ARGV[0]),aliases:true);STDOUT.write(JSON.generate(v))`;
for(const name of fs.readdirSync(dir).filter(x=>/\.ya?ml$/.test(x)).sort()){
  const file=path.join(dir,name);let doc;
  try{doc=JSON.parse(execFileSync("ruby",["-e",ruby,file],{encoding:"utf8"}))}catch(error){throw new Error(`${name}: YAML parse failed: ${error.message}`)}
  if(!Object.hasOwn(doc,"permissions"))throw new Error(`${name}: explicit top-level permissions required`);
  const top=doc.permissions;if(top==="write-all")throw new Error(`${name}: write-all forbidden`);
  if(JSON.stringify(doc.concurrency)===JSON.stringify(authority))throw new Error(`${name}: workflow-level deployment authority lock forbidden`);
  if(typeof top!=="string"&&(top===null||Array.isArray(top)||typeof top!=="object"))throw new Error(`${name}: invalid top-level permissions`);
  for(const [jobName,job] of Object.entries(doc.jobs??{})){
    if(!job||typeof job!=="object"||Array.isArray(job))throw new Error(`${name}:${jobName}: invalid job`);
    const effective=Object.hasOwn(job,"permissions")?job.permissions:top;
    if(effective==="write-all")throw new Error(`${name}:${jobName}: write-all forbidden`);
    if(typeof effective!=="string"&&(effective===null||Array.isArray(effective)||typeof effective!=="object"))throw new Error(`${name}:${jobName}: invalid permissions`);
    if(JSON.stringify(effective).includes("${{"))throw new Error(`${name}:${jobName}: dynamic permissions forbidden`);
    const writes=typeof effective==="object"&&effective.deployments==="write";
    if(writes&&!allowed.get(name)?.has(jobName))throw new Error(`${name}:${jobName}: unauthorized deployments:write`);
    const reusableAuthorityCaller=name==="authorize-release.yml"&&jobName==="authorize";
    if(writes&&!reusableAuthorityCaller){
      if(JSON.stringify(job.concurrency)!==JSON.stringify(authority))throw new Error(`${name}:${jobName}: deployment authority concurrency mismatch`);
    }
    if(reusableAuthorityCaller&&Object.hasOwn(job,"concurrency"))throw new Error(`${name}:${jobName}: reusable caller must not re-enter deployment authority lock`);
    if(!writes&&JSON.stringify(job.concurrency)===JSON.stringify(authority))throw new Error(`${name}:${jobName}: non-writer deployment authority lock forbidden`);
    if(writes){const digest=createHash("sha256").update(JSON.stringify(job)).digest("hex"),expected=exactWriterJobs.get(`${name}:${jobName}`);if(!expected||digest!==expected)throw new Error(`${name}:${jobName}: protected writer job shape mismatch`)}
    if(name==="ci.yml"&&typeof effective==="object"&&effective.deployments==="write"&&job.if!=="github.event_name == 'workflow_call'")throw new Error(`${name}:${jobName}: reusable deployment writer lacks exact workflow_call guard`);
    if(typeof job.uses==="string"&&job.uses.startsWith("./.github/workflows/")&&(name!=="authorize-release.yml"||jobName!=="authorize"||job.uses!=="./.github/workflows/ci.yml")){
      throw new Error(`${name}:${jobName}: unauthorized local reusable workflow caller`);
    }
  }
  const visit=value=>{if(Array.isArray(value))return value.forEach(visit);if(!value||typeof value!=="object")return;for(const [key,item] of Object.entries(value)){if(key==="uses"&&typeof item==="string"&&item.includes("/.github/workflows/")&&!item.startsWith("./"))throw new Error(`${name}: remote reusable workflows forbidden`);visit(item)}};visit(doc.jobs??{});
}
