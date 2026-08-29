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
  if(command==="hold-lock"&&args.length===1){let release!:()=>void;const until=new Promise<void>(resolvePromise=>{release=resolvePromise;});process.once("SIGTERM",release);process.once("SIGINT",release);await ledger.holdLock(resolve(args[0]!),until);return;}
  if(command==="reconcile"&&(args.length===2||args.length===3)){
    if(process.env.DELETION_RECONCILE_AUTHORIZATION!=="AUTHORIZE_DELETION_LEDGER_RECONCILIATION")throw new Error("RECONCILIATION_AUTHORIZATION_REQUIRED");
    await assertSafeDatabaseEnvironment();
    const [auditId,operationDigest,confirmation]=args;
    const pending=validateLedgerContent(await readFile(path!)).get(auditId!);if(!pending||pending.digest!==operationDigest)throw new Error("PENDING_OPERATION_NOT_FOUND");const token=process.env.DELETION_RECONCILE_GRANT_TOKEN;if(!token)throw new Error("ROLLBACK_GRANT_REQUIRED");const grantHash=createHash("sha256").update(token).digest("hex"),confirmed=confirmation==="--confirm-rolled-back=I_CONFIRM_THE_DATABASE_TRANSACTION_ROLLED_BACK";
    const sql=`begin isolation level serializable; with state as (select case when exists(select 1 from public.deletion_audit where id='${auditId}'::uuid and filter_hash='${operationDigest}') then 'C' when exists(select 1 from public.deletion_audit where id='${auditId}'::uuid) then 'X' else 'A' end value), valid as (select g.id,g.admin_user_id,g.admin_session_id from public.admin_reauth_grants g join public.admin_sessions s on s.id=g.admin_session_id and s.admin_user_id=g.admin_user_id join public.admin_users u on u.id=g.admin_user_id cross join state where g.token_hash='${grantHash}' and g.purpose='deletion_reconcile' and g.consumed_at is null and g.expires_at>now() and u.active and s.revoked_at is null and s.archived_at is null and s.expires_at>now() and s.last_seen_at>now()-interval '30 minutes' and s.created_at>now()-interval '12 hours' and (state.value='C' or (state.value='A' and ${confirmed?'true':'false'})) for update of g,s,u), consumed as (update public.admin_reauth_grants g set consumed_at=now() from valid v where g.id=v.id returning v.admin_user_id,v.admin_session_id), audited as (insert into public.admin_audit(admin_user_id,admin_session_id,action,target_type,target_id,outcome,details) select admin_user_id,admin_session_id,'deletion.ledger.reconcile','deletion_audit','${auditId}','success',jsonb_build_object('auditId','${auditId}','operationDigest','${operationDigest}') from consumed returning 1) select (select restore_target_id from restore_control.deployment_environment where singleton=true),(select value from state),(select count(*) from audited); commit;`;
    const {stdout}=await executeFile("psql",["-X","-v","ON_ERROR_STOP=1","-Atqc",sql]),line=stdout.trim().split("\n").find(value=>value.includes("|")),[source,state,authorized]=line?.split("|")??[];if(source!==pending.sourceInstanceId)throw new Error("SOURCE_INSTANCE_MISMATCH");if(state==="X")throw new Error("DELETION_AUDIT_DIGEST_CORRUPTION");if(authorized!=="1")throw new Error("ROLLBACK_GRANT_REQUIRED");if(state==="C")await ledger.recordCommitted({auditId:auditId!,operationDigest:operationDigest!});else if(state==="A")await ledger.recordAborted({auditId:auditId!,operationDigest:operationDigest!});else throw new Error("INVALID_RECONCILIATION_STATE");console.log(state);return;
  }
  throw new Error("USAGE: deletion-ledger-cli snapshot LEDGER DEST | reconcile LEDGER AUDIT_ID DIGEST [--confirm-rolled-back]");
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===resolve(process.argv[1]))main().catch(error=>{console.error(error instanceof Error?error.message:String(error));process.exitCode=1;});
