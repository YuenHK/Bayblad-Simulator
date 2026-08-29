#!/usr/bin/env node
import{readFileSync}from"node:fs";const [file,commit]=process.argv.slice(2),run=JSON.parse(readFileSync(file,"utf8"));if(run.path!==".github/workflows/ci.yml"||run.head_sha!==commit||run.event!=="push"||run.conclusion!=="success"||!/^v[0-9]/u.test(run.head_branch??""))throw new Error("release run is not a successful tagged CI run");process.stdout.write(run.head_branch);
