#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
const [previousPath,currentPath,previousCommit,currentCommit,repository,statePath,output]=process.argv.slice(2);
if(!output||!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository))throw new Error("usage");
const previous=JSON.parse(readFileSync(previousPath,"utf8")),current=JSON.parse(readFileSync(currentPath,"utf8")),state=JSON.parse(readFileSync(statePath,"utf8"));
if(previous.schemaVersion!==1||current.schemaVersion!==1||previous.commit!==previousCommit||current.commit!==currentCommit||previous.images?.migration!==previous.images?.server||current.images?.migration!==current.images?.server||state.schemaVersion!==4||state.purpose!=="production"||state.smoke?.complete!==true||state.commit!==currentCommit||!/^\d+$/u.test(state.deploymentId)||!/^[a-f0-9]{64}$/u.test(state.manifestSha256))throw new Error("source identity invalid");
const base=`ghcr.io/${repository.toLowerCase()}/steam-top/`,pattern=(name)=>new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/gu,"\\$&")}${name}@sha256:[a-f0-9]{64}$`,"u");
if(!pattern("server").test(previous.images.server)||!pattern("web").test(previous.images.web)||!pattern("database").test(current.images.database))throw new Error("source image path invalid");
const images={server:previous.images.server,migration:previous.images.server,web:previous.images.web,database:current.images.database};
writeFileSync(output,JSON.stringify({schemaVersion:1,commit:previousCommit,images,rollbackSources:{schemaVersion:4,purpose:"production",applicationCommit:previousCommit,databaseCommit:currentCommit,databaseEnginePreserved:true,currentDeploymentId:state.deploymentId,currentDeploymentCreatedAt:state.deploymentCreatedAt,currentManifestSha256:state.manifestSha256,currentSmoke:{complete:true}}},null,2)+"\n",{flag:"wx",mode:0o600});
