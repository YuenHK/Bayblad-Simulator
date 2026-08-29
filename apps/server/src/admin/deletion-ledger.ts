import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";

export interface DeletionLedger { recordPending(input: Readonly<{ auditId: string; operationDigest: string }>): Promise<void>; recordCommitted(input: Readonly<{ auditId: string; operationDigest: string }>): Promise<void>; recordAborted(input: Readonly<{ auditId: string; operationDigest: string }>): Promise<void>; }

/** External append-only tombstones make backups predating a deletion ineligible for restore. */
export class FileDeletionLedger implements DeletionLedger {
  constructor(readonly path: string) { if (!isAbsolute(path)) throw new TypeError("DELETION_LEDGER_FILE_MUST_BE_ABSOLUTE"); }
  async #privateDirectory() { const directory=dirname(this.path);await mkdir(directory,{recursive:true,mode:0o700});const info=await lstat(directory);if(!info.isDirectory()||info.isSymbolicLink()||info.uid!==process.getuid?.())throw new Error("UNSAFE_DELETION_LEDGER_DIRECTORY");await chmod(directory,0o700);return directory; }
  async #lock(directory:string){const lock=`${this.path}.lock`;for(let attempt=0;attempt<50;attempt++){try{await mkdir(lock,{mode:0o700});await writeFile(`${lock}/owner`,JSON.stringify({pid:process.pid,createdAt:Date.now()}),{flag:"wx",mode:0o600});return async()=>{const info=await lstat(lock);if(!info.isDirectory()||info.isSymbolicLink()||info.uid!==process.getuid?.())throw new Error("UNSAFE_DELETION_LEDGER_LOCK");await rm(lock,{recursive:true});const parent=await open(directory,constants.O_RDONLY);try{await parent.sync();}finally{await parent.close();}};}catch(error){if((error as NodeJS.ErrnoException).code!=="EEXIST")throw error;try{const info=await lstat(lock);if(!info.isDirectory()||info.isSymbolicLink()||info.uid!==process.getuid?.()||(info.mode&0o077)!==0)throw new Error("UNSAFE_DELETION_LEDGER_LOCK");let owner:{pid?:unknown;createdAt?:unknown}|undefined;try{owner=JSON.parse(await readFile(`${lock}/owner`,"utf8")) as typeof owner;}catch(ownerError){if((ownerError as NodeJS.ErrnoException).code!=="ENOENT"&&!(ownerError instanceof SyntaxError))throw ownerError;}const alive=typeof owner?.pid==="number"&&owner.pid>0&&(()=>{try{process.kill(owner.pid!,0);return true;}catch{return false;}})();const createdAt=typeof owner?.createdAt==="number"?owner.createdAt:info.mtimeMs;if(!alive&&Date.now()-createdAt>30_000){const stale=`${lock}.stale-${process.pid}-${Date.now()}`;await rename(lock,stale);await rm(stale,{recursive:true});continue;}}catch(staleError){if((staleError as NodeJS.ErrnoException).code!=="ENOENT")throw staleError;}await new Promise(resolve=>setTimeout(resolve,20));}}throw new Error("DELETION_LEDGER_LOCK_TIMEOUT");}
  async #record(state: "P" | "C" | "A", input: { auditId: string; operationDigest: string }): Promise<void> {
    if (!/^[0-9a-f-]{36}$/iu.test(input.auditId) || !/^[a-f0-9]{64}$/u.test(input.operationDigest)) throw new TypeError("INVALID_DELETION_TOMBSTONE");
    const directory=await this.#privateDirectory(),release=await this.#lock(directory);
    try {
    try { const info = await lstat(this.path); if (!info.isFile() || info.isSymbolicLink() || info.uid!==process.getuid?.() || (info.mode&0o077)!==0 || info.size > 64 * 1024 * 1024) throw new Error("UNSAFE_DELETION_LEDGER"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const line=`${state} ${input.auditId.toLowerCase()} ${input.operationDigest}\n`;
    try { if ((await readFile(this.path,"utf8")).split("\n").includes(line.trimEnd())) return; } catch (error) { if ((error as NodeJS.ErrnoException).code!=="ENOENT") throw error; }
    const file = await open(this.path,constants.O_WRONLY|constants.O_APPEND|constants.O_CREAT|constants.O_NOFOLLOW,0o600);
    try { const fd=await file.stat(),pathInfo=await stat(this.path);if(!fd.isFile()||fd.uid!==process.getuid?.()||(fd.mode&0o077)!==0||fd.ino!==pathInfo.ino||fd.dev!==pathInfo.dev)throw new Error("UNSAFE_DELETION_LEDGER");await file.write(line);await file.datasync();await file.chmod(0o600); }
    finally { await file.close(); }
    const parent=await open(directory,constants.O_RDONLY);try{await parent.sync();}finally{await parent.close();}
    }finally{await release();}
  }
  recordPending(input: { auditId: string; operationDigest: string }) { return this.#record("P", input); }
  recordCommitted(input: { auditId: string; operationDigest: string }) { return this.#record("C", input); }
  recordAborted(input: { auditId: string; operationDigest: string }) { return this.#record("A", input); }
}
