import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat,readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { FileDeletionLedger,validateLedgerContent } from "./deletion-ledger.js";

const executeFile=promisify(execFile);
export type ReconciliationTerminal="C"|"A";
export type ReconciliationTombstone=Readonly<{auditId:string;operationDigest:string;sourceInstanceId:string}>;
export interface ReconciliationDatabaseRunner{
  decide(input:Readonly<{tombstone:ReconciliationTombstone;confirmedRollback:boolean;grantHash:string}>):Promise<Readonly<{terminal:ReconciliationTerminal;sourceInstanceId:string}>>;
  complete(input:Readonly<{tombstone:ReconciliationTombstone;terminal:ReconciliationTerminal}>):Promise<void>;
}

export async function reconcileProductionDeletion(input:Readonly<{tombstone:ReconciliationTombstone;ledger:Pick<FileDeletionLedger,"recoverCommitted"|"recoverAborted">;confirmedRollback:boolean;grantHash:string;database:ReconciliationDatabaseRunner}>):Promise<ReconciliationTerminal>{
  if(!/^[0-9a-f-]{36}$/iu.test(input.tombstone.auditId)||!/^[a-f0-9]{64}$/u.test(input.tombstone.operationDigest)||!/^[0-9a-f-]{36}$/iu.test(input.tombstone.sourceInstanceId))throw new TypeError("INVALID_DELETION_TOMBSTONE");
  const decision=await input.database.decide({tombstone:input.tombstone,confirmedRollback:input.confirmedRollback,grantHash:input.grantHash});
  if(decision.sourceInstanceId!==input.tombstone.sourceInstanceId)throw new Error("SOURCE_INSTANCE_MISMATCH");
  if(decision.terminal==="C")await input.ledger.recoverCommitted(input.tombstone);else await input.ledger.recoverAborted(input.tombstone);
  await input.database.complete({tombstone:input.tombstone,terminal:decision.terminal});
  return decision.terminal;
}

type ExecutePsql=(sql:string)=>Promise<string>;
export class PsqlReconciliationDatabaseRunner implements ReconciliationDatabaseRunner{
  readonly #execute:ExecutePsql;
  constructor(execute:ExecutePsql=async sql=>(await executeFile("psql",["-X","-v","ON_ERROR_STOP=1","-Atqc",sql])).stdout){this.#execute=execute;}
  async decide({tombstone,confirmedRollback,grantHash}:Parameters<ReconciliationDatabaseRunner["decide"]>[0]){
    const {auditId,operationDigest}=tombstone;
    const sql=`begin isolation level serializable; with marker as materialized (select restore_target_id from restore_control.deployment_environment where singleton), op as materialized (select o.* from public.deletion_operations o where o.audit_id='${auditId}'::uuid for update of o), valid as (select g.id,g.admin_user_id,g.admin_session_id from public.admin_reauth_grants g join public.admin_sessions s on s.id=g.admin_session_id and s.admin_user_id=g.admin_user_id join public.admin_users u on u.id=g.admin_user_id join op on op.status='pending' and op.operation_digest='${operationDigest}' and op.created_at<=now()-interval '15 minutes' join marker on marker.restore_target_id=op.source_instance_id where g.token_hash='${grantHash}' and g.purpose='deletion_reconcile' and g.consumed_at is null and g.expires_at>now() and u.active and s.revoked_at is null and s.archived_at is null and s.expires_at>now() and s.last_seen_at>now()-interval '30 minutes' and s.created_at>now()-interval '12 hours' and ${confirmedRollback?'true':'false'} for update of g,s,u), consumed as (update public.admin_reauth_grants g set consumed_at=now() from valid v where g.id=v.id returning v.admin_user_id,v.admin_session_id), aborted as (update public.deletion_operations o set status='aborted',updated_at=now(),terminal_at=now() from consumed where o.audit_id='${auditId}'::uuid and o.status='pending' returning o.*), terminal as (select case when status='committed' then 'C' when status='aborted' then 'A' end value from op,marker where operation_digest='${operationDigest}' and source_instance_id=marker.restore_target_id union all select 'A' from aborted), queued as (insert into public.deletion_ledger_outbox(audit_id,operation_digest,terminal) select '${auditId}'::uuid,'${operationDigest}',value from terminal where value is not null on conflict(audit_id,terminal) do update set operation_digest=excluded.operation_digest returning id,terminal), audited as (insert into public.admin_audit(admin_user_id,admin_session_id,action,target_type,target_id,outcome,details) select admin_user_id,admin_session_id,'deletion.ledger.reconcile.accepted','deletion_operation','${auditId}','success',jsonb_build_object('auditId','${auditId}','operationDigest','${operationDigest}') from consumed returning 1) select (select source_instance_id from op),(select restore_target_id from marker),(select operation_digest from op),(select terminal from queued limit 1),case when (select status from op)='pending' then (select count(*) from consumed) else case when exists(select 1 from op) then 1 else 0 end end; commit;`;
    const line=(await this.#execute(sql)).trim().split("\n").find(value=>value.includes("|")),[source,target,digest,state,authorized]=line?.split("|")??[];
    if(!source)throw new Error("DELETION_OPERATION_NOT_FOUND");if(source!==target)throw new Error("SOURCE_INSTANCE_MISMATCH");if(digest!==operationDigest)throw new Error("DELETION_OPERATION_DIGEST_CORRUPTION");if(authorized!=="1")throw new Error("ROLLBACK_GRANT_REQUIRED");if(state!=="C"&&state!=="A")throw new Error("INVALID_RECONCILIATION_STATE");return {terminal:state as ReconciliationTerminal,sourceInstanceId:source};
  }
  async complete({tombstone,terminal}:Parameters<ReconciliationDatabaseRunner["complete"]>[0]){const {auditId,operationDigest}=tombstone;const sql=`begin; with done as (update public.deletion_ledger_outbox set completed_at=coalesce(completed_at,now()) where audit_id='${auditId}'::uuid and operation_digest='${operationDigest}' and terminal='${terminal}' returning id), audited as (insert into public.admin_audit(action,target_type,target_id,outcome,details,source_outbox_id) select 'deletion.ledger.reconcile.success','deletion_operation','${auditId}','success',jsonb_build_object('auditId','${auditId}','operationDigest','${operationDigest}'),id from done on conflict(source_outbox_id) where source_outbox_id is not null do nothing returning 1) select count(*) from done; commit;`;const count=(await this.#execute(sql)).trim().split("\n").find(value=>/^\d+$/u.test(value));if(count!=="1")throw new Error("DELETION_LEDGER_OUTBOX_CORRUPTION");}
}
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
    const pending=validateLedgerContent(await readFile(path!)).get(auditId!);if(!pending||pending.digest!==operationDigest)throw new Error("PENDING_OPERATION_NOT_FOUND");const token=process.env.DELETION_RECONCILE_GRANT_TOKEN??"",grantHash=createHash("sha256").update(token).digest("hex"),confirmed=confirmation==="--confirm-rolled-back=I_CONFIRM_THE_DATABASE_TRANSACTION_ROLLED_BACK";
    const state=await reconcileProductionDeletion({tombstone:{auditId:auditId!,operationDigest:operationDigest!,sourceInstanceId:pending.sourceInstanceId},ledger,confirmedRollback:confirmed,grantHash,database:new PsqlReconciliationDatabaseRunner()});console.log(state);return;
  }
  throw new Error("USAGE: deletion-ledger-cli snapshot LEDGER DEST | reconcile LEDGER AUDIT_ID DIGEST [--confirm-rolled-back]");
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===resolve(process.argv[1]))main().catch(error=>{console.error(error instanceof Error?error.message:String(error));process.exitCode=1;});
