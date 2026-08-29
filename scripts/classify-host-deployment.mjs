#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
const [manifestPath,containersPath,imagesPath,caddyRef,purpose,output]=process.argv.slice(2);
const manifest=JSON.parse(readFileSync(manifestPath,"utf8")),containers=JSON.parse(readFileSync(containersPath,"utf8")),images=JSON.parse(readFileSync(imagesPath,"utf8"));
const project={production:"steam-top-simulator","release-integration":"steam-top-release-integration"}[purpose];
const expected={db:manifest.images.database,migration:manifest.images.server,server:manifest.images.server,web:manifest.images.web,caddy:caddyRef};
let complete=Boolean(project)&&containers.length===5;
const seen=new Set();
for(const item of containers){const labels=item.Config?.Labels??{},service=labels["com.docker.compose.service"],migration=service==="migration";if(!Object.hasOwn(expected,service)||seen.has(service)||labels["com.docker.compose.project"]!==project||item.Config?.Image!==expected[service]||(migration?(item.State?.Status!=="exited"||item.State?.ExitCode!==0):(item.State?.Status!=="running"||item.State?.Health?.Status!=="healthy")))complete=false;seen.add(service);}
for(const ref of new Set(Object.values(expected)))if(images.filter(x=>Array.isArray(x.RepoDigests)&&x.RepoDigests.includes(ref)).length!==1)complete=false;
if(seen.size!==5)complete=false;
writeFileSync(output,JSON.stringify({classification:complete?"complete":"partial"})+"\n",{flag:"wx",mode:0o600});
