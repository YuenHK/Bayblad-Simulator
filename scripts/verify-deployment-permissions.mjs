import fs from "node:fs";
import path from "node:path";

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
for(const name of fs.readdirSync(dir).filter(x=>/\.ya?ml$/.test(x)).sort()){
  const lines=fs.readFileSync(path.join(dir,name),"utf8").split(/\r?\n/);let job="";
  for(let i=0;i<lines.length;i++){
    const m=lines[i].match(/^  ([A-Za-z0-9_-]+):\s*$/);if(m)job=m[1];
    if(!/deployments:\s*write/.test(lines[i]))continue;
    if(!allowed.get(name)?.has(job))throw new Error(`${name}:${i+1}: unauthorized deployments:write in ${job||"top-level"}`);
    if(name==="ci.yml"){
      const block=lines.slice(Math.max(0,i-10),i+1).join("\n");
      if(!block.includes("if: github.event_name == 'workflow_call'"))throw new Error(`${name}:${i+1}: reusable deployment writer lacks workflow_call guard`);
    }
  }
}
