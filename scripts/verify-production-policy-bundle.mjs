import fs from "node:fs";
import path from "node:path";
import {createHash,timingSafeEqual} from "node:crypto";

const root=path.resolve(process.argv[2]??"."),expected=process.argv[3];
const files=[
  ".github/workflows/authorize-release.yml",
  ".github/workflows/ci.yml",
  ".github/workflows/reconcile-deployment.yml",
  ".github/workflows/reconcile-production-e2e.yml",
  ".github/workflows/record-deployment.yml",
  "scripts/classify-production-e2e-fallback.mjs",
  "scripts/verify-deployment-permissions.mjs",
  "scripts/verify-production-policy-bundle.mjs",
];
const hash=createHash("sha256");for(const relative of files){const bytes=fs.readFileSync(path.join(root,relative));hash.update(`${relative}\0${bytes.length}\0`);hash.update(bytes)}const digest=hash.digest("hex");
if(expected!==undefined){if(!/^[a-f0-9]{64}$/.test(expected)||!timingSafeEqual(Buffer.from(digest,"hex"),Buffer.from(expected,"hex")))throw new Error("protected production policy bundle digest mismatch")}
process.stdout.write(`${digest}\n`);
