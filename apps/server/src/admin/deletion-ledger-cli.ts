import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { FileDeletionLedger } from "./deletion-ledger.js";

const executeFile=promisify(execFile);
export async function reconcileLedger(input:Readonly<{ledger:FileDeletionLedger;auditId:string;operationDigest:string;confirmRolledBack:boolean;lookupAudit:(auditId:string,operationDigest:string)=>Promise<boolean>}>){
  if(!/^[0-9a-f-]{36}$/iu.test(input.auditId)||!/^[a-f0-9]{64}$/u.test(input.operationDigest))throw new TypeError("INVALID_DELETION_TOMBSTONE");
  if(await input.lookupAudit(input.auditId,input.operationDigest)){await input.ledger.recordCommitted(input);return "C" as const;}
  if(!input.confirmRolledBack)throw new Error("ROLLBACK_CONFIRMATION_REQUIRED");
  await input.ledger.recordAborted(input);return "A" as const;
}

async function main(){
  const [command,path,...args]=process.argv.slice(2),ledger=new FileDeletionLedger(path??"");
  if(command==="snapshot"&&args.length===1){console.log(JSON.stringify(await ledger.snapshot(args[0]!)));return;}
  if(command==="reconcile"&&(args.length===2||args.length===3)){
    if(process.env.DELETION_RECONCILE_AUTHORIZATION!=="AUTHORIZE_DELETION_LEDGER_RECONCILIATION")throw new Error("RECONCILIATION_AUTHORIZATION_REQUIRED");
    const [auditId,operationDigest,confirmation]=args;
    const result=await reconcileLedger({ledger,auditId:auditId!,operationDigest:operationDigest!,confirmRolledBack:confirmation==="--confirm-rolled-back",lookupAudit:async(id,digest)=>{const {stdout}=await executeFile("psql",["-X","-v","ON_ERROR_STOP=1","-Atqc","select exists(select 1 from deletion_audit where id='"+id+"'::uuid and filter_hash='"+digest+"')"]);return stdout.trim()==="t";}});
    console.log(result);return;
  }
  throw new Error("USAGE: deletion-ledger-cli snapshot LEDGER DEST | reconcile LEDGER AUDIT_ID DIGEST [--confirm-rolled-back]");
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===resolve(process.argv[1]))main().catch(error=>{console.error(error instanceof Error?error.message:String(error));process.exitCode=1;});
