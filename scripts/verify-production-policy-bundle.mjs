import fs from "node:fs";
import path from "node:path";
import {createHash,timingSafeEqual} from "node:crypto";

const root=path.resolve(process.argv[2]??"."),expected=process.argv[3],manifestOut=process.argv[4];
const roots=[".github","drizzle","infra","scripts"],files=[];
const ignored=new Set(["node_modules","dist","coverage",".turbo",".cache"]);
const walk=relative=>{if(relative.split("/").some(part=>ignored.has(part)))return;const absolute=path.join(root,relative),stat=fs.lstatSync(absolute);if(stat.isSymbolicLink())throw new Error(`authority closure rejects symlink: ${relative}`);if(stat.isDirectory()){for(const name of fs.readdirSync(absolute).sort())walk(path.posix.join(relative,name));return}if(!stat.isFile())throw new Error(`authority closure rejects nonregular file: ${relative}`);files.push(relative)};
for(const relative of roots){if(!fs.existsSync(path.join(root,relative)))throw new Error(`authority closure root missing: ${relative}`);walk(relative)}
for(const name of fs.readdirSync(root).sort())if(/^(?:\.dockerignore|Caddyfile|Dockerfile(?:\..+)?|compose(?:\..+)?\.ya?ml|package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|playwright\.config\.[cm]?[jt]s|tsconfig(?:\..+)?\.json)$/u.test(name))walk(name);
files.sort();const hash=createHash("sha256"),manifest=[];for(const relative of files){const absolute=path.join(root,relative),bytes=fs.readFileSync(absolute),stat=fs.lstatSync(absolute);if(!stat.isFile()||stat.isSymbolicLink()||bytes.length!==stat.size)throw new Error(`authority file changed while hashing: ${relative}`);const contentSha256=createHash("sha256").update(bytes).digest("hex");manifest.push({path:relative,type:"regular",size:bytes.length,sha256:contentSha256});hash.update(`regular\0${relative}\0${bytes.length}\0`);hash.update(bytes)}const digest=hash.digest("hex");
if(expected!==undefined){if(!/^[a-f0-9]{64}$/.test(expected)||!timingSafeEqual(Buffer.from(digest,"hex"),Buffer.from(expected,"hex")))throw new Error("protected production policy bundle digest mismatch")}
if(manifestOut)fs.writeFileSync(manifestOut,JSON.stringify({schemaVersion:1,purpose:"production-authority-closure",files,digest,entries:manifest})+"\n",{flag:"wx",mode:0o600});
process.stdout.write(`${digest}\n`);
