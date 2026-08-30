import {spawn} from "node:child_process";
import {existsSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach,expect,it} from "vitest";

const roots:string[]=[];afterEach(()=>{while(roots.length)rmSync(roots.pop()!,{recursive:true,force:true})});
const linuxIt=process.platform==="linux"?it:it.skip;
const waitFor=async(test:()=>boolean)=>{const end=Date.now()+3000;while(!test()){if(Date.now()>end)throw new Error("condition timeout");await new Promise(resolve=>setTimeout(resolve,20))}};
const alive=(pid:number)=>{try{process.kill(pid,0);return true}catch{return false}};

linuxIt("reaps a stubborn leader and descendant and exits 143 on SIGTERM",async()=>{const root=mkdtempSync(join(tmpdir(),"policy-supervisor-"));roots.push(root);const leader=join(root,"leader"),child=join(root,"child"),script=join(root,"stubborn.sh");writeFileSync(script,`#!/bin/bash\ntrap '' TERM\necho $$ > '${leader}'\n( trap '' TERM; echo $$ > '${child}'; while :; do sleep 1; done ) &\nwhile :; do sleep 1; done\n`,{mode:0o755});const supervisor=spawn("/usr/bin/python3",["scripts/supervise-process-group.py",script],{stdio:"ignore"}),closed=new Promise<number|null>(resolve=>supervisor.once("close",resolve));await waitFor(()=>existsSync(leader)&&existsSync(child));const leaderPid=Number(readFileSync(leader,"utf8")),childPid=Number(readFileSync(child,"utf8"));supervisor.kill("SIGTERM");expect(await closed).toBe(143);await waitFor(()=>!alive(leaderPid)&&!alive(childPid));},10000);

linuxIt("fails closed and kills descendants when the leader exits first",async()=>{const root=mkdtempSync(join(tmpdir(),"policy-supervisor-exit-"));roots.push(root);const child=join(root,"child"),script=join(root,"leader-exits.sh");writeFileSync(script,`#!/bin/bash\n( trap '' TERM; echo $$ > '${child}'; while :; do sleep 1; done ) &\nexit 0\n`,{mode:0o755});const supervisor=spawn("/usr/bin/python3",["scripts/supervise-process-group.py",script],{stdio:"ignore"}),closed=new Promise<number|null>(resolve=>supervisor.once("close",resolve));await waitFor(()=>existsSync(child));const childPid=Number(readFileSync(child,"utf8"));expect(await closed).toBe(70);await waitFor(()=>!alive(childPid));},10000);
