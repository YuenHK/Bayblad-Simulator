#!/usr/bin/env node
import { readFileSync,writeFileSync } from "node:fs";
import { parseProductionEnv,canonicalProductionEnv } from "./production-env.mjs";
import { validateDeploymentValues } from "./validate-deployment-env.mjs";
import { verifyReleaseManifest } from "./verify-release-manifest.mjs";
const [manifestPath,environmentPath,outputPath,repository,commit]=process.argv.slice(2);
if(!commit)throw new Error("usage: authorize-production-deploy MANIFEST ENV OUTPUT REPOSITORY COMMIT");
const environment=parseProductionEnv(readFileSync(environmentPath,"utf8"));
validateDeploymentValues(environment);
verifyReleaseManifest(JSON.parse(readFileSync(manifestPath,"utf8")),environment,repository,commit);
writeFileSync(outputPath,canonicalProductionEnv(environment),{flag:"wx",mode:0o600});
