import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat,readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { FileDeletionLedger,validateLedgerContent } from "./deletion-ledger.js";

const executeFile=promisify(execFile);
async function assertSafeDatabaseEnvironment(){const allowed=new Set(["PGSERVICE","PGSERVICEFILE","PGPASSFILE"]);for(const key of Object.keys(process.env))if(key.startsWith("PG")&&!allowed.has(key))throw new Error(`FORBIDDEN_LIBPQ_OVERRIDE_${key}`);if(!/^[A-Za-z0-9_.-]{1,64}$/u.test(process.env.PGSERVICE??""))throw new Error("INVALID_PGSERVICE");for(const key of ["PGSERVICEFILE","PGPASSFILE"]){const value=process.env[key];if(!value)throw new Error(`${key}_REQUIRED`);const info=await lstat(value);if(!info.isFile()||info.isSymbolicLink()||info.uid!==process.getuid?.()||(info.mode&0o077)!==0)throw new Error(`${key}_UNSAFE`);}}
export async function reconcileLedger(input:Readonly<{ledger:FileDeletionLedger;auditId:string;operationDigest:string;sourceInstanceId?:string;confirmRolledBack:boolean;lookupAudit:(auditId:string,operationDigest:string)=>Promise<Readonly<{exists:boolean;sourceInstanceId:string}>>;authorizeRollback?:()=>Promise<boolean>}>){
  if(!/^[0-9a-f-]{36}$/iu.test(input.auditId)||!/^[a-f0-9]{64}$/u.test(input.operationDigest))throw new TypeError("INVALID_DELETION_TOMBSTONE");
  const lookup=await input.lookupAudit(input.auditId,input.operationDigest);if(input.sourceInstanceId&&lookup.sourceInstanceId!==input.sourceInstanceId)throw new Error("SOURCE_INSTANCE_MISMATCH");if(lookup.exists){await input.ledger.recordCommitted(input);return "C" as const;}
  if(!input.confirmRolledBack)throw new Error("ROLLBACK_CONFIRMATION_REQUIRED");
  if(!input.authorizeRollback||!await input.authorizeRollback())throw new Error("ROLLBACK_GRANT_REQUIRED");
  await input.ledger.recordAborted(input);return "A" as const;
}

async function main(){
  const [command,path,...args]=process.argv.slice(2),ledger=new FileDeletionLedger(path??"");
  if(command==="snapshot"&&args.length===1){console.log(JSON.stringify(await ledger.snapshot(args[0]!,true)));return;}
  if(command==="validate"&&args.length===0){const content=await readFile(path!);validateLedgerContent(content,true);console.log(JSON.stringify({lines:content.toString("utf8").split("\n").filter(Boolean).length,sha256:createHash("sha256").update(content).digest("hex")}));return;}
  if(command==="reconcile"&&(args.length===2||args.length===3)){
    if(process.env.DELETION_RECONCILE_AUTHORIZATION!=="AUTHORIZE_DELETION_LEDGER_RECONCILIATION")throw new Error("RECONCILIATION_AUTHORIZATION_REQUIRED");
    await assertSafeDatabaseEnvironment();
    const [auditId,operationDigest,confirmation]=args;
    const pending=validateLedgerContent(await readFile(path!)).get(auditId!);if(!pending||pending.digest!==operationDigest)throw new Error("PENDING_OPERATION_NOT_FOUND");
    const result=await reconcileLedger({ledger,auditId:auditId!,operationDigest:operationDigest!,sourceInstanceId:pending.sourceInstanceId,confirmRolledBack:confirmation==="--confirm-rolled-back=I_CONFIRM_THE_DATABASE_TRANSACTION_ROLLED_BACK",lookupAudit:async(id,digest)=>{const {stdout}=await executeFile("psql",["-X","-v","ON_ERROR_STOP=1","-Atqc","select (select restore_target_id from restore_control.deployment_environment where singleton=true)||'|'||exists(select 1 from deletion_audit where id='"+id+"'::uuid and filter_hash='"+digest+"')"]);const [sourceInstanceId,exists]=stdout.trim().split("|");if(!sourceInstanceId)throw new Error("SOURCE_INSTANCE_UNAVAILABLE");return{sourceInstanceId,exists:exists==="t"};},authorizeRollback:async()=>{const token=process.env.DELETION_RECONCILE_GRANT_TOKEN;if(!token)return false;const hash=createHash("sha256").update(token).digest("hex"),{stdout}=await executeFile("psql",["-X","-v","ON_ERROR_STOP=1","-Atqc","update admin_reauth_grants set consumed_at=now() where token_hash='"+hash+"' and purpose='deletion_reconcile' and consumed_at is null and expires_at>now() returning 1"]);return stdout.trim()==="1";}});
    console.log(result);return;
  }
  throw new Error("USAGE: deletion-ledger-cli snapshot LEDGER DEST | reconcile LEDGER AUDIT_ID DIGEST [--confirm-rolled-back]");
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===resolve(process.argv[1]))main().catch(error=>{console.error(error instanceof Error?error.message:String(error));process.exitCode=1;});
