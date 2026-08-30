import {createHash} from "node:crypto";
import {chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {basename, join} from "node:path";
import {spawnSync} from "node:child_process";
import {afterEach, expect, it} from "vitest";

const roots:string[]=[];
afterEach(()=>{while(roots.length)rmSync(roots.pop()!,{recursive:true,force:true})});
const sha256=(value:string|Buffer)=>createHash("sha256").update(value).digest("hex");

const fixture=()=>{
  const root=mkdtempSync(join(tmpdir(),"policy-ceremony-"));roots.push(root);
  const fakeBin=join(root,"bin"),gh=join(fakeBin,"gh");
  mkdirSync(fakeBin);
  writeFileSync(gh,"#!/bin/bash\nset -eu\nbundle=\nwhile (($#));do if [[ $1 == --bundle ]];then bundle=$2;shift 2;else shift;fi;done\nif [[ $(cat \"$bundle\") != valid-bundle ]];then exit 42;fi\ncat \"$FAKE_GH_EVIDENCE\"\n");chmodSync(gh,0o755);
  const repository="school/steam-top",repositoryId="123",workflow=`${repository}/.github/workflows/rotate-production-policy.yml`,workflowRef=`${workflow}@refs/heads/main`,workflowSha="a".repeat(40),bundleSha="b".repeat(64),runId=91,runAttempt=2;
  const anchorPath=join(root,"anchor.json"),bundlePath=join(root,"attestation.bundle"),intentPath=join(root,"intent.json"),evidencePath=join(root,"evidence.json"),output=join(root,"entry.json");
  const anchor:any={schemaVersion:1,rootAllowedSignersB64:Buffer.from("root-key ssh-ed25519 AAAA\n").toString("base64"),rootKeySha256:"c".repeat(64),ledgerGeneration:1,ledgerReceiptDigest:"d".repeat(64),anchorGeneration:2,rotationRepositoryId:repositoryId,rotationRepositoryName:repository,rotationWorkflowRef:workflowRef,rotationWorkflowSha:workflowSha,ledgerAnchorSha256:"e".repeat(64),ledgerAnchorGeneration:1,updatedAt:"2026-08-30T00:00:00.000Z"};
  writeFileSync(anchorPath,`${JSON.stringify(anchor)}\n`);const anchorSha=sha256(readFileSync(anchorPath));writeFileSync(bundlePath,"valid-bundle");
  const intent:any={schemaVersion:1,purpose:"production-policy-rotation-intent",authorized:false,repositoryId,repositoryName:repository,policyCommit:"f".repeat(40),policyTreeOid:"1".repeat(40),nextGeneration:2,previousReceiptDigest:anchor.ledgerReceiptDigest,bundleSha256:bundleSha,trustedWorkflowRef:workflowRef,trustedWorkflowSha:workflowSha,verifierSha256:"2".repeat(64),anchorSha256:anchorSha,anchorGeneration:anchor.anchorGeneration,runId,runAttempt,createdAt:"2026-08-30T00:00:01.000Z"};
  const writeEvidence=(subject=intent,mutate?:(value:any)=>void)=>{writeFileSync(intentPath,JSON.stringify(subject));const value=[{verificationResult:{statement:{subject:[{name:basename(intentPath),digest:{sha256:sha256(readFileSync(intentPath))}}]},signature:{certificate:{issuer:"https://token.actions.githubusercontent.com",sourceRepositoryUri:`https://github.com/${repository}`,sourceRepositoryRef:workflowRef.slice(workflow.length+1),sourceWorkflow:workflow,sourceWorkflowDigest:workflowSha}}}}];mutate?.(value);writeFileSync(evidencePath,JSON.stringify(value))};
  writeEvidence();
  const run=(overrides:{intent?:any;anchor?:any;bundle?:string;expectedRun?:number;expectedAttempt?:number;expectedBundle?:string;evidenceMutate?:(value:any)=>void}={})=>{if(overrides.anchor){writeFileSync(anchorPath,`${JSON.stringify(overrides.anchor)}\n`)}writeFileSync(bundlePath,overrides.bundle??"valid-bundle");writeEvidence(overrides.intent??intent,overrides.evidenceMutate);return spawnSync("infra/bootstrap/verify-and-create-production-policy-entry.sh",[intentPath,bundlePath,anchorPath,repository,String(overrides.expectedRun??runId),String(overrides.expectedAttempt??runAttempt),overrides.expectedBundle??bundleSha,"root-key",output],{cwd:process.cwd(),env:{...process.env,PATH:`${fakeBin}:${process.env.PATH}`,FAKE_GH_EVIDENCE:evidencePath},encoding:"utf8"})};
  return {anchor,intent,run,output,workflow,workflowRef,workflowSha,bundleSha,repository};
};

it("creates an entry only from the externally bound attested ceremony",()=>{const x=fixture(),result=x.run();expect(result.status,result.stderr).toBe(0);expect(JSON.parse(readFileSync(x.output,"utf8"))).toMatchObject({repositoryId:"123",bundleSha256:x.bundleSha})});
it("creates genesis only from the exact zero sentinel and never rolls a later intent back to generation one",()=>{const x=fixture(),zero="0".repeat(64),genesis={...x.anchor,ledgerGeneration:0,ledgerReceiptDigest:zero,ledgerAnchorSha256:zero,ledgerAnchorGeneration:0,anchorGeneration:1},anchorSha=sha256(`${JSON.stringify(genesis)}\n`),first={...x.intent,nextGeneration:1,previousReceiptDigest:zero,anchorGeneration:1,anchorSha256:anchorSha};let result=x.run({anchor:genesis,intent:first});expect(result.status,result.stderr).toBe(0);const y=fixture(),rollback={...y.intent,nextGeneration:1,previousReceiptDigest:zero};result=y.run({intent:rollback});expect(result.status).not.toBe(0);expect(()=>readFileSync(y.output)).toThrow()});

it("rejects every externally bound ceremony identity mismatch",()=>{
  const cases:Array<[string,(x:ReturnType<typeof fixture>)=>Parameters<ReturnType<typeof fixture>["run"]>[0]]>=[
    ["run id",x=>({intent:{...x.intent,runId:x.intent.runId+1}})],
    ["run attempt",x=>({intent:{...x.intent,runAttempt:x.intent.runAttempt+1}})],
    ["subject",_=>({evidenceMutate:value=>{value[0].verificationResult.statement.subject[0].name="other.json"}})],
    ["digest",_=>({evidenceMutate:value=>{value[0].verificationResult.statement.subject[0].digest.sha256="0".repeat(64)}})],
    ["repository id",x=>({intent:{...x.intent,repositoryId:"999"}})],
    ["repository name",x=>({intent:{...x.intent,repositoryName:"other/repo"}})],
    ["workflow ref",x=>{const ref=`${x.workflow}@refs/heads/evil`;return {intent:{...x.intent,trustedWorkflowRef:ref},evidenceMutate:value=>{value[0].verificationResult.signature.certificate.sourceRepositoryRef="refs/heads/evil"}}}],
    ["workflow sha",x=>{const sha="9".repeat(40);return {intent:{...x.intent,trustedWorkflowSha:sha},evidenceMutate:value=>{value[0].verificationResult.signature.certificate.sourceWorkflowDigest=sha}}}],
    ["policy bundle",x=>({intent:{...x.intent,bundleSha256:"8".repeat(64)}})],
    ["attestation bundle",_=>({bundle:"wrong-bundle"})],
    ["anchor",x=>({anchor:{...x.anchor,anchorGeneration:x.anchor.anchorGeneration+1}})],
  ];
  for(const [name,build] of cases){const x=fixture(),result=x.run(build(x));expect(result.status,`${name} unexpectedly passed`).not.toBe(0);expect(()=>readFileSync(x.output)).toThrow()}
});
