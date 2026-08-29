import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
const [rootArg,manifestArg,outputArg]=process.argv.slice(2),root=resolve(rootArg),output=resolve(outputArg);
if(!rootArg||!manifestArg||!outputArg)throw new Error("root, manifest and output required");
for(const line of readFileSync(manifestArg,"utf8").trim().split("\n")){const match=/^[a-f0-9]{64} 0(?:444|555) ([A-Za-z0-9._/-]+)$/u.exec(line);if(!match||match[1].includes(".."))throw new Error("runtime manifest grammar");const source=join(root,match[1]),target=join(output,match[1]);mkdirSync(dirname(target),{recursive:true});copyFileSync(source,target);}
