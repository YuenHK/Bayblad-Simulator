import {execFileSync} from "node:child_process";
import {mkdtempSync,mkdirSync,writeFileSync,appendFileSync,readFileSync,cpSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach,describe,expect,it} from "vitest";

const roots:string[]=[];
afterEach(()=>{while(roots.length)rmSync(roots.pop()!,{recursive:true,force:true})});
function run(files:Record<string,string>){const root=mkdtempSync(join(tmpdir(),"deployment-policy-"));roots.push(root);const dir=join(root,".github/workflows");mkdirSync(dir,{recursive:true});for(const [name,text] of Object.entries(files))writeFileSync(join(dir,name),text);return()=>execFileSync(process.execPath,["scripts/verify-deployment-permissions.mjs",root],{stdio:"pipe"})}

describe("deployment permission policy",()=>{
  it("accepts the exact protected writer shapes and sole local caller",()=>expect(()=>execFileSync(process.execPath,["scripts/verify-deployment-permissions.mjs"],{stdio:"pipe"})).not.toThrow());
  for(const [name,yaml] of Object.entries({
    implicit:"jobs:\n  x: {runs-on: ubuntu-latest}\n",
    writeAll:"permissions: write-all\njobs:\n  x: {runs-on: ubuntu-latest}\n",
    quoted:"permissions: {contents: read}\njobs:\n  x:\n    permissions: {'deployments': 'write'}\n    runs-on: ubuntu-latest\n",
    override:"permissions: {deployments: write}\njobs:\n  x:\n    permissions: {contents: read, deployments: write}\n    runs-on: ubuntu-latest\n",
    dynamic:"permissions: {contents: read}\njobs:\n  x:\n    permissions: {deployments: '${{ matrix.permission }}'}\n    runs-on: ubuntu-latest\n",
    caller:"permissions: {contents: read}\njobs:\n  x:\n    uses: ./.github/workflows/ci.yml\n",
  }))it(`rejects ${name} permission form`,()=>expect(run({"evil.yml":yaml})).toThrow());
  it("resolves aliases before enforcing write-all",()=>expect(run({"evil.yml":"permissions: &p write-all\njobs:\n  x:\n    permissions: *p\n    runs-on: ubuntu-latest\n"})).toThrow());
  it("rejects same-repository or external remote reusable syntax",()=>expect(run({"evil.yml":"permissions: {}\njobs:\n  x:\n    uses: school/steam-top/.github/workflows/ci.yml@main\n"})).toThrow(/remote reusable workflows forbidden/));
  it("rejects an allowlisted writer when runs-on, steps, concurrency or bound command changes",()=>{const source=readFileSync(".github/workflows/reconcile-production-e2e.yml","utf8");for(const changed of [source.replace("runs-on: ubuntu-24.04","runs-on: arbitrary"),source.replaceAll("group: production-deployment-status-authority","group: other"),source.replace("Mark only orphaned matching Deployments terminal error","arbitrary writer command")])expect(run({"reconcile-production-e2e.yml":changed})).toThrow()});
  it("rejects workflow plus job lock re-entry",()=>{const source=readFileSync(".github/workflows/reconcile-production-e2e.yml","utf8").replace("permissions: { contents: read }","permissions: { contents: read }\nconcurrency: { group: production-deployment-status-authority, cancel-in-progress: false }");expect(run({"reconcile-production-e2e.yml":source})).toThrow(/workflow-level deployment authority lock forbidden/)});
  it("does not trust a candidate verifier changed alongside its writer",()=>{const source=readFileSync(".github/workflows/reconcile-production-e2e.yml","utf8").replace("runs-on: ubuntu-24.04","runs-on: attacker");expect(run({"reconcile-production-e2e.yml":source,"candidate-verifier.yml":"permissions: {}\njobs: {}\n"})).toThrow(/protected writer job shape mismatch/)});
  it("keeps an externally pinned bundle authoritative over synchronized candidate self-modification",()=>{const root=mkdtempSync(join(tmpdir(),"policy-bundle-"));roots.push(root);cpSync(".github",join(root,".github"),{recursive:true});mkdirSync(join(root,"scripts"));for(const name of ["classify-production-e2e-fallback.mjs","verify-deployment-permissions.mjs","verify-production-policy-bundle.mjs"])cpSync(join("scripts",name),join(root,"scripts",name));const trusted=execFileSync(process.execPath,["scripts/verify-production-policy-bundle.mjs","."],{encoding:"utf8"}).trim();appendFileSync(join(root,"scripts/verify-deployment-permissions.mjs"),"\n// candidate changes verifier and embedded hashes together\n");expect(()=>execFileSync(process.execPath,["scripts/verify-production-policy-bundle.mjs",root,trusted],{stdio:"pipe"})).toThrow(/bundle digest mismatch/)});
});
