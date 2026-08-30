import {execFileSync} from "node:child_process";
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach,describe,expect,it} from "vitest";

const roots:string[]=[];
afterEach(()=>{while(roots.length)rmSync(roots.pop()!,{recursive:true,force:true})});
function run(files:Record<string,string>){const root=mkdtempSync(join(tmpdir(),"deployment-policy-"));roots.push(root);const dir=join(root,".github/workflows");mkdirSync(dir,{recursive:true});for(const [name,text] of Object.entries(files))writeFileSync(join(dir,name),text);return()=>execFileSync(process.execPath,["scripts/verify-deployment-permissions.mjs",root],{stdio:"pipe"})}

describe("deployment permission policy",()=>{
  it("accepts parsed flow mappings and the sole protected reusable caller",()=>expect(run({
    "authorize-release.yml":"permissions: {contents: read}\njobs:\n  authorize:\n    permissions: {contents: read, deployments: write}\n    uses: ./.github/workflows/ci.yml\n",
    "ci.yml":"permissions: read-all\njobs:\n  production-first-deploy-e2e:\n    if: github.event_name == 'workflow_call'\n    permissions: { deployments: 'write', contents: read }\n    runs-on: ubuntu-latest\n  release-host-core-integration:\n    if: github.event_name == 'workflow_call'\n    permissions: {deployments: write}\n    runs-on: ubuntu-latest\n",
  })).not.toThrow());
  for(const [name,yaml] of Object.entries({
    implicit:"jobs:\n  x: {runs-on: ubuntu-latest}\n",
    writeAll:"permissions: write-all\njobs:\n  x: {runs-on: ubuntu-latest}\n",
    quoted:"permissions: {contents: read}\njobs:\n  x:\n    permissions: {'deployments': 'write'}\n    runs-on: ubuntu-latest\n",
    override:"permissions: {deployments: write}\njobs:\n  x:\n    permissions: {contents: read, deployments: write}\n    runs-on: ubuntu-latest\n",
    dynamic:"permissions: {contents: read}\njobs:\n  x:\n    permissions: {deployments: '${{ matrix.permission }}'}\n    runs-on: ubuntu-latest\n",
    caller:"permissions: {contents: read}\njobs:\n  x:\n    uses: ./.github/workflows/ci.yml\n",
  }))it(`rejects ${name} permission form`,()=>expect(run({"evil.yml":yaml})).toThrow());
  it("resolves aliases before enforcing write-all",()=>expect(run({"evil.yml":"permissions: &p write-all\njobs:\n  x:\n    permissions: *p\n    runs-on: ubuntu-latest\n"})).toThrow());
});
