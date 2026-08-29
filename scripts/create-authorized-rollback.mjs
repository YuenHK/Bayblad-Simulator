#!/usr/bin/env node
import {readFileSync,writeFileSync} from "node:fs";
const [previousPath,currentPath,previousCommit,currentCommit,output]=process.argv.slice(2);if(!output)throw new Error("usage");
const previous=JSON.parse(readFileSync(previousPath,"utf8")),current=JSON.parse(readFileSync(currentPath,"utf8"));
if(previous.commit!==previousCommit||current.commit!==currentCommit||previous.images?.migration!==previous.images?.server||current.images?.migration!==current.images?.server)throw new Error("source identity invalid");
const images={server:previous.images.server,migration:previous.images.server,web:previous.images.web,database:current.images.database};for(const image of Object.values(images))if(!/^ghcr\.io\/[a-z0-9_.\/-]+@sha256:[a-f0-9]{64}$/u.test(image))throw new Error("source image invalid");
writeFileSync(output,JSON.stringify({schemaVersion:1,commit:previousCommit,images,rollbackSources:{applicationCommit:previousCommit,databaseCommit:currentCommit,databaseEnginePreserved:images.database===current.images.database}},null,2)+"\n",{flag:"wx",mode:0o600});
