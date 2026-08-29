#!/usr/bin/env node
import{readFileSync}from"node:fs";const [file,name]=process.argv.slice(2),body=JSON.parse(readFileSync(file,"utf8"));const matches=(body.artifacts??[]).filter(x=>x.name===name&&!x.expired);if(matches.length!==1)throw new Error("artifact is not uniquely owned by the verified run");
