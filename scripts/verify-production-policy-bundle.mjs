import fs from "node:fs";
import path from "node:path";
import {createHash,timingSafeEqual} from "node:crypto";
import {execFile} from "node:child_process";

const GIT="/usr/bin/git";
const root=fs.realpathSync(path.resolve(process.argv[2]??"."));
const expected=process.argv[3],manifestOut=process.argv[4];
const temporary=fs.mkdtempSync("/tmp/steam-top-policy-verify-");
let cleaning=false;
let activeGitChild=null;
let activeGitClosed=Promise.resolve();
let terminating=false;
const cleanup=()=>{if(cleaning)return;cleaning=true;fs.rmSync(temporary,{recursive:true,force:true})};
const delay=milliseconds=>new Promise(resolve=>setTimeout(resolve,milliseconds));
const terminate=number=>{if(terminating)return;terminating=true;(async()=>{const child=activeGitChild,closed=activeGitClosed;if(child?.pid){try{process.kill(-child.pid,"SIGTERM")}catch{}await Promise.race([closed,delay(750)]);if(activeGitChild?.pid){try{process.kill(-child.pid,"SIGKILL")}catch{}}await Promise.race([closed,delay(750)])}cleanup();process.exit(128+number)})().catch(()=>{cleanup();process.exit(128+number)})};
const signalHandlers=new Map([["SIGHUP",1],["SIGINT",2],["SIGTERM",15]].map(([signal,number])=>[signal,()=>terminate(number)]));
for(const [signal,handler] of signalHandlers)process.once(signal,handler);
process.once("exit",cleanup);
if(typeof process.send==="function")process.send({purpose:"steam-top-policy-temporary-ready"});
const baseEnvironment={PATH:"/usr/bin:/bin",LANG:"C",LC_ALL:"C",HOME:temporary,XDG_CONFIG_HOME:temporary,TMPDIR:temporary,GIT_CONFIG_NOSYSTEM:"1",GIT_CONFIG_GLOBAL:"/dev/null",GIT_TERMINAL_PROMPT:"0"};
const safeGitConfig=["-c","core.fsmonitor=false","-c","core.hooksPath=/dev/null","-c","core.attributesFile=/dev/null"];
const git=(args,options={})=>new Promise((resolve,reject)=>{let closeResolve;const closed=new Promise(done=>{closeResolve=done});const child=execFile(GIT,[...safeGitConfig,...args],{encoding:null,detached:true,...options,env:{...baseEnvironment,...options.env}},(error,stdout)=>error?reject(error):resolve(stdout));activeGitChild=child;activeGitClosed=closed;child.once("close",()=>{closeResolve();if(activeGitChild===child)activeGitChild=null});if(typeof process.send==="function")process.send({purpose:"steam-top-policy-git-child-running",pid:child.pid})});
const frame=value=>{const bytes=Buffer.isBuffer(value)?value:Buffer.from(String(value),"utf8");return Buffer.concat([Buffer.from(`${bytes.length}:`,"ascii"),bytes])};
const sameStat=(a,b)=>a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeNs===b.mtimeNs&&a.ctimeNs===b.ctimeNs;

try{
  if(!fs.existsSync(GIT))throw new Error("trusted Git binary unavailable");
  const top=fs.realpathSync((await git(["-C",root,"rev-parse","--show-toplevel"],{encoding:"utf8"})).trim());
  if(top!==root)throw new Error("authority root must equal repository root");
  if((await git(["-C",root,"rev-parse","--show-object-format"],{encoding:"utf8"})).trim()!=="sha1")throw new Error("production policy bundle supports SHA-1 repositories only");
  const indexPathRaw=(await git(["-C",root,"rev-parse","--git-path","index"],{encoding:"utf8"})).trim();
  const indexPath=path.isAbsolute(indexPathRaw)?indexPathRaw:path.join(root,indexPathRaw);
  const indexBefore=fs.readFileSync(indexPath),indexStatBefore=fs.statSync(indexPath,{bigint:true});
  const temporaryIndex=path.join(temporary,"index");
  fs.copyFileSync(indexPath,temporaryIndex);
  const indexEnvironment={GIT_INDEX_FILE:temporaryIndex};
  const assertOriginalIndex=()=>{const after=fs.statSync(indexPath,{bigint:true});if(!fs.readFileSync(indexPath).equals(indexBefore)||!sameStat(indexStatBefore,after))throw new Error("original Git index changed during verification")};
  let writeTree,headTree,status;
  try{
    writeTree=(await git(["-C",root,"write-tree"],{encoding:"utf8",env:indexEnvironment})).trim();
    headTree=(await git(["-C",root,"rev-parse","HEAD^{tree}"],{encoding:"utf8"})).trim();
    await git(["-C",root,"update-index","--really-refresh"],{stdio:"ignore",env:indexEnvironment});
    if((await git(["-C",root,"write-tree"],{encoding:"utf8",env:indexEnvironment})).trim()!==writeTree)throw new Error("index tree changed during refresh");
    await git(["-C",root,"diff-files","--quiet","--"],{stdio:"ignore",env:indexEnvironment});
    status=await git(["-C",root,"status","--porcelain=v2","-z","--untracked-files=all","--ignored=matching"],{maxBuffer:64*1024*1024,env:indexEnvironment});
  }catch{throw new Error("clean HEAD required for production policy bundle")}
  if(writeTree!==headTree||status.length!==0)throw new Error("clean HEAD required for production policy bundle");
  const index=await git(["-C",root,"ls-files","--stage","-z"],{maxBuffer:64*1024*1024,env:indexEnvironment});
  const records=[];for(let start=0,end;(end=index.indexOf(0,start))!==-1;start=end+1)if(end>start)records.push(index.subarray(start,end));
  const entries=[],decoder=new TextDecoder("utf-8",{fatal:true});
  for(const raw of records){
    const tab=raw.indexOf(9);if(tab<0)throw new Error("authority git index entry rejected");
    const match=raw.subarray(0,tab).toString("ascii").match(/^(100644|100755|120000) ([a-f0-9]{40}) 0$/),pathBytes=raw.subarray(tab+1);
    if(!match)throw new Error("authority git index entry rejected");
    let decoded;try{decoded=decoder.decode(pathBytes)}catch{throw new Error("authority index path rejected: invalid UTF-8")}
    if(!Buffer.from(decoded,"utf8").equals(pathBytes)||decoded!==decoded.normalize("NFC")||/[\u0000-\u001f\u007f\\]/u.test(decoded)||decoded.startsWith("/")||decoded.split("/").some(part=>part===""||part==="."||part===".."))throw new Error("authority index path rejected: non-canonical path");
    if(match[1]==="120000")throw new Error(`authority closure rejects symlink: ${decoded}`);
    entries.push({path:decoded,pathBytes,oid:match[2],mode:match[1]==="100755"?0o755:0o644});
  }
  entries.sort((a,b)=>a.pathBytes.compare(b.pathBytes));
  if(new Set(entries.map(entry=>entry.path)).size!==entries.length)throw new Error("duplicate authority path");
  const tracked=new Set(entries.map(entry=>entry.path));
  const trackedDirectories=new Set(entries.flatMap(entry=>{const parts=entry.path.split("/");return parts.slice(0,-1).map((_,index)=>parts.slice(0,index+1).join("/"))}));
  const walk=(directory,relative="")=>{for(const item of fs.readdirSync(directory,{withFileTypes:true})){if(!relative&&item.name===".git")continue;const child=relative?`${relative}/${item.name}`:item.name;if(item.isDirectory()){if(!trackedDirectories.has(child))throw new Error(`clean HEAD required for production policy bundle: untracked directory ${child}`);walk(path.join(directory,item.name),child)}else if(!tracked.has(child))throw new Error(`clean HEAD required for production policy bundle: untracked path ${child}`)}};
  walk(root);
  const hash=createHash("sha256"),manifest=[];
  for(const entry of entries){
    const bytes=await git(["-C",root,"cat-file","blob",entry.oid],{maxBuffer:256*1024*1024});
    const declared=Number((await git(["-C",root,"cat-file","-s",entry.oid],{encoding:"utf8"})).trim());
    if(!Number.isSafeInteger(declared)||declared!==bytes.length)throw new Error(`authority blob size mismatch: ${entry.path}`);
    const contentSha256=createHash("sha256").update(bytes).digest("hex"),mode=entry.mode.toString(8);
    manifest.push({path:entry.path,type:"regular",mode,size:bytes.length,sha256:contentSha256});
    for(const field of ["regular",entry.pathBytes,mode,String(bytes.length),bytes])hash.update(frame(field));
  }
  const digest=hash.digest("hex");
  if(expected!==undefined&&(!/^[a-f0-9]{64}$/.test(expected)||!timingSafeEqual(Buffer.from(digest,"hex"),Buffer.from(expected,"hex"))))throw new Error("protected production policy bundle digest mismatch");
  assertOriginalIndex();
  if(manifestOut)fs.writeFileSync(manifestOut,JSON.stringify({schemaVersion:1,purpose:"production-authority-closure",digest,entries:manifest})+"\n",{flag:"wx",mode:0o600});
  process.stdout.write(`${digest}\n`);
}finally{
  for(const [signal,handler] of signalHandlers)process.removeListener(signal,handler);
  cleanup();
}
