import {execFileSync,spawnSync} from "node:child_process";
import {mkdtempSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {basename,join} from "node:path";
import {createHash} from "node:crypto";
import {describe,expect,it} from "vitest";
const repo="school/steam-top",workflow=`${repo}/.github/workflows/record-deployment.yml`,ref="refs/heads/main",sha="a".repeat(40);
const fixture=(mutate?:(x:any)=>void)=>{const dir=mkdtempSync(join(tmpdir(),"attestation-")),subject=join(dir,"deployment-authorization.json"),config=join(dir,"trust.json"),evidence=join(dir,"evidence.json");writeFileSync(subject,"authorized\n");const digest=createHash("sha256").update("authorized\n").digest("hex"),result=[{verificationResult:{statement:{subject:[{name:basename(subject),digest:{sha256:digest}}]},signature:{certificate:{issuer:"https://token.actions.githubusercontent.com",sourceRepositoryUri:`https://github.com/${repo}`,sourceRepositoryRef:ref,sourceWorkflow:workflow,sourceWorkflowDigest:sha}}}}];mutate?.(result);writeFileSync(config,JSON.stringify({repository:repo,workflowIdentity:workflow,workflowRef:ref,workflowSha:sha}));writeFileSync(evidence,JSON.stringify(result));return {evidence,config,subject};};
const run=(x:ReturnType<typeof fixture>)=>spawnSync(process.execPath,["infra/bootstrap/verify-attestation-identity.mjs",x.evidence,x.config,x.subject],{encoding:"utf8"});
describe("GitHub attestation identity",()=>{
 it("accepts one exact verified subject and certificate",()=>expect(run(fixture()).status).toBe(0));
 it("rejects identity strings placed outside the certificate",()=>{const x=fixture(r=>{r[0].verificationResult.signature.certificate.sourceWorkflow="evil/workflow.yml";r[0].untrusted=`${workflow} ${ref} ${sha}`});expect(run(x).status).not.toBe(0);});
 it("rejects a different subject digest",()=>{const x=fixture(r=>{r[0].verificationResult.statement.subject[0].digest.sha256="b".repeat(64)});expect(run(x).status).not.toBe(0);});
 it("rejects multiple verification results",()=>{const x=fixture(r=>r.push(structuredClone(r[0])));expect(run(x).status).not.toBe(0);});
});
