#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
const paths=process.argv.slice(2);
if(paths.length<3)process.exit(2);
const sources=paths.map((path)=>readFileSync(path,"utf8"));
for(const name of ["steam_top_protect_deployment_environment","deletion_audit_sha256","assert_pristine_platform_installation"]){
  const expression=new RegExp(`FUNCTION\\s+(?:"?restore_control"?\\.)?"?${name}"?\\([^)]*\\)[\\s\\S]*?\\bAS\\s+\\$\\$([\\s\\S]*?)\\$\\$\\s*;`,"u"),matches=sources.map(source=>expression.exec(source)).filter(Boolean);
  if(matches.length<1)throw new Error(`canonical function source missing: ${name}`);
  process.stdout.write(`${createHash("sha256").update(matches.at(-1)[1]).digest("hex")} `);
}
process.stdout.write("\n");
