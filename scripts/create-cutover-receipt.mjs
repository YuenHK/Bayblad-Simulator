#!/usr/bin/env node
import {readFileSync,writeFileSync} from "node:fs";
import {createHash} from "node:crypto";
const [readyPath,databaseUrlFile,origin,manifestDigest,nonce,probePath,output]=process.argv.slice(2),ready=JSON.parse(readFileSync(readyPath,"utf8")),probe=JSON.parse(readFileSync(probePath,"utf8")),url=new URL(readFileSync(databaseUrlFile,"utf8").trim());
if(!/^postgres(?:ql)?:$/u.test(url.protocol)||!/^https:\/\/[a-z0-9.-]+(?::[0-9]+)?$/u.test(origin)||!/^[a-f0-9]{64}$/u.test(manifestDigest)||!/^[a-f0-9]{64}$/u.test(nonce)||ready.schemaVersion!==2||probe.nonce!==nonce||probe.restoreTargetId!==ready.restoreTargetId||probe.systemIdentifier!==ready.systemIdentifier)throw new Error("cutover receipt input invalid");
url.username="";url.password="";url.searchParams.sort();const databaseUrlSha256=createHash("sha256").update(url.toString()).digest("hex"),readySha256=createHash("sha256").update(readFileSync(readyPath)).digest("hex");
writeFileSync(output,JSON.stringify({schemaVersion:1,readySha256,systemIdentifier:ready.systemIdentifier,database:ready.database,appRole:ready.appRole,restoreTargetId:ready.restoreTargetId,ledgerRows:ready.ledgerRows,databaseUrlSha256,deploymentManifestSha256:manifestDigest,publicOrigin:origin,publicSmoke:"passed",nonce,createdAt:new Date().toISOString()},null,2)+"\n",{flag:"wx",mode:0o400});
