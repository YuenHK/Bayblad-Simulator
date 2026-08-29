#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
const [previousPath,currentPath,envPath,manifestOut,envOut]=process.argv.slice(2);if(!envOut)throw new Error("usage: create-application-rollback PREVIOUS CURRENT ENV MANIFEST_OUT ENV_OUT");
const previous=JSON.parse(readFileSync(previousPath,"utf8")),current=JSON.parse(readFileSync(currentPath,"utf8"));
if(previous.schemaVersion!==1||current.schemaVersion!==1||previous.images?.migration!==previous.images?.server)throw new Error("source release manifest invalid");
const images={server:previous.images.server,migration:previous.images.server,web:previous.images.web,database:current.images.database};
for(const value of Object.values(images))if(!/^[a-z0-9][a-z0-9._\/-]*@sha256:[a-f0-9]{64}$/u.test(value))throw new Error("source image ref invalid");
const manifest={schemaVersion:1,commit:previous.commit,images,rollbackSources:{applicationCommit:previous.commit,databaseCommit:current.commit,databaseEnginePreserved:true}};
const lines=readFileSync(envPath,"utf8").split(/\r?\n/u),seen=new Set();const replacements={SERVER_IMAGE:images.server,WEB_IMAGE:images.web,DATABASE_IMAGE:images.database};
const output=lines.map(line=>{const match=/^([A-Z][A-Z0-9_]*)=(.*)$/u.exec(line);if(!match||!(match[1] in replacements))return line;if(seen.has(match[1]))throw new Error(`duplicate ${match[1]}`);seen.add(match[1]);return `${match[1]}=${replacements[match[1]]}`;});
if(seen.size!==3)throw new Error("environment lacks application image keys");
writeFileSync(manifestOut,`${JSON.stringify(manifest,null,2)}\n`,{flag:"wx",mode:0o600});writeFileSync(envOut,output.join("\n"),{flag:"wx",mode:0o600});
