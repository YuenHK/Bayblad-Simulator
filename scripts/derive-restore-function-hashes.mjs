#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
const [baseline,cutover,installation]=process.argv.slice(2);
if(!installation)process.exit(2);
const sources=[readFileSync(baseline,"utf8"),readFileSync(cutover,"utf8"),readFileSync(installation,"utf8")];
for(const name of ["steam_top_protect_deployment_environment","deletion_audit_sha256","assert_pristine_platform_installation"]){
  const expression=new RegExp(`FUNCTION\\s+(?:"?restore_control"?\\.)?"?${name}"?\\([^)]*\\)[\\s\\S]*?\\bAS\\s+\\$\\$([\\s\\S]*?)\\$\\$\\s*;`,"u"),matches=sources.map(source=>expression.exec(source)).filter(Boolean);
  if(matches.length!==1)throw new Error(`canonical function source missing or ambiguous: ${name}`);
  process.stdout.write(`${createHash("sha256").update(matches[0][1]).digest("hex")} `);
}
process.stdout.write("\n");
