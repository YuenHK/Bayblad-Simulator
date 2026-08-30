import fs from "node:fs";
import path from "node:path";
import {createHash,timingSafeEqual} from "node:crypto";
import {execFileSync} from "node:child_process";
import {readStableAuthorityFileWithIdentity} from "./read-stable-authority-file.mjs";

const root=path.resolve(process.argv[2]??"."),expected=process.argv[3],manifestOut=process.argv[4];
const frame=value=>{const bytes=Buffer.isBuffer(value)?value:Buffer.from(String(value),"utf8");return Buffer.concat([Buffer.from(`${bytes.length}:`,"ascii"),bytes])};
const index=execFileSync("git",["-C",root,"ls-files","--stage","-z"],{maxBuffer:64*1024*1024}),entries=[];for(const raw of index.toString("utf8").split("\0").filter(Boolean)){const match=raw.match(/^(100644|100755|120000) [a-f0-9]{40,64} 0\t(.+)$/s);if(!match)throw new Error("authority git index entry rejected");if(match[1]==="120000")throw new Error(`authority closure rejects symlink: ${match[2]}`);entries.push({path:match[2],mode:match[1]==="100755"?0o755:0o644})}entries.sort((a,b)=>Buffer.from(a.path).compare(Buffer.from(b.path)));if(new Set(entries.map(x=>x.path)).size!==entries.length)throw new Error("duplicate authority path");
const tracked=new Set(entries.map(x=>x.path));for(const item of fs.readdirSync(root,{withFileTypes:true})){if(item.name===".git"||item.isDirectory())continue;if(!tracked.has(item.name))throw new Error(`untracked root authority entry rejected: ${item.name}`)}
const hash=createHash("sha256"),manifest=[];for(const entry of entries){const allowedModes=entry.mode===0o755?[0o555,0o755]:[0o444,0o644],{bytes,mode:liveMode}=readStableAuthorityFileWithIdentity(path.join(root,entry.path),allowedModes),contentSha256=createHash("sha256").update(bytes).digest("hex"),mode=liveMode.toString(8);manifest.push({path:entry.path,type:"regular",mode,size:bytes.length,sha256:contentSha256});for(const field of ["regular",entry.path,mode,String(bytes.length),bytes])hash.update(frame(field))}const digest=hash.digest("hex");
if(expected!==undefined){if(!/^[a-f0-9]{64}$/.test(expected)||!timingSafeEqual(Buffer.from(digest,"hex"),Buffer.from(expected,"hex")))throw new Error("protected production policy bundle digest mismatch")}
if(manifestOut)fs.writeFileSync(manifestOut,JSON.stringify({schemaVersion:1,purpose:"production-authority-closure",digest,entries:manifest})+"\n",{flag:"wx",mode:0o600});
process.stdout.write(`${digest}\n`);
