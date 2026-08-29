import {createHash} from "node:crypto";
import {readFileSync} from "node:fs";
import {basename} from "node:path";
const [evidencePath,configPath,subjectPath]=process.argv.slice(2),evidence=JSON.parse(readFileSync(evidencePath,"utf8")),config=JSON.parse(readFileSync(configPath,"utf8")),subject=readFileSync(subjectPath),digest=createHash("sha256").update(subject).digest("hex");
if(!Array.isArray(evidence)||evidence.length!==1)throw new Error("one attestation verification result required");
const result=evidence[0]?.verificationResult,subjects=result?.statement?.subject,certificate=result?.signature?.certificate;
if(!result||!Array.isArray(subjects)||subjects.length!==1||subjects[0]?.name!==basename(subjectPath)||subjects[0]?.digest?.sha256!==digest)throw new Error("attestation subject mismatch");
if(certificate?.issuer!=="https://token.actions.githubusercontent.com"||certificate.sourceRepositoryUri!==`https://github.com/${config.repository}`||certificate.sourceRepositoryRef!==config.workflowRef||certificate.sourceWorkflow!==config.workflowIdentity||certificate.sourceWorkflowDigest!==config.workflowSha)throw new Error("attestation certificate identity mismatch");
