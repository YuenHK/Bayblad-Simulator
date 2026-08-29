import {execFileSync,spawnSync} from "node:child_process";
import {mkdtempSync,readFileSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {describe,expect,it} from "vitest";

const git=(cwd:string,...args:string[])=>execFileSync("git",args,{cwd,encoding:"utf8"}).trim();
const fixture=()=>{const cwd=mkdtempSync(join(tmpdir(),"steam-top-tag-"));git(cwd,"init","-q");git(cwd,"config","user.name","CI Fixture");git(cwd,"config","user.email","ci@example.invalid");writeFileSync(join(cwd,"release.txt"),"immutable\n");git(cwd,"add","release.txt");git(cwd,"commit","-qm","release");return cwd;};
const verify=(cwd:string,tag:string)=>{const commit=git(cwd,"rev-parse","HEAD"),ref=git(cwd,"rev-parse",tag),type=git(cwd,"cat-file","-t",ref),chain=type==="tag"?[{type,sha:ref},{type:"commit",sha:git(cwd,"rev-parse",`${tag}^{commit}`)}]:[{type,sha:ref}],path=join(cwd,"chain.ndjson");writeFileSync(path,chain.map(x=>JSON.stringify(x)).join("\n")+"\n");return spawnSync(process.execPath,["scripts/verify-github-tag-chain.mjs",path,commit],{cwd:process.cwd(),encoding:"utf8"});};

describe("release tag peeling",()=>{
  it("accepts a real lightweight Git tag",()=>{const cwd=fixture();git(cwd,"tag","v1.0.0");expect(verify(cwd,"v1.0.0").status).toBe(0);});
  it("accepts a real annotated Git tag peeled to its commit",()=>{const cwd=fixture();git(cwd,"tag","-a","v1.0.0","-m","approved release");expect(verify(cwd,"v1.0.0").status).toBe(0);});
  it("rejects a tag chain bound to another commit",()=>{const cwd=fixture();git(cwd,"tag","v1.0.0");const result=verify(cwd,"v1.0.0"),path=join(cwd,"chain.ndjson");expect(result.status).toBe(0);const wrong="0".repeat(40),rejected=spawnSync(process.execPath,["scripts/verify-github-tag-chain.mjs",path,wrong],{cwd:process.cwd(),encoding:"utf8"});expect(rejected.status).not.toBe(0);expect(readFileSync(path,"utf8")).toContain(git(cwd,"rev-parse","HEAD"));});
});
