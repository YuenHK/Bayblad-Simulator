import fs from "node:fs";

const same=(a,b)=>a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mode===b.mode&&a.nlink===b.nlink&&a.mtimeNs===b.mtimeNs&&a.ctimeNs===b.ctimeNs;
export function readStableAuthorityFileWithIdentity(file,expectedMode,afterOpen){
  if(typeof fs.constants.O_NOFOLLOW!=="number")throw new Error("O_NOFOLLOW unavailable");
  const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{
    const before=fs.fstatSync(fd,{bigint:true}),mode=Number(before.mode&0o777n),modes=Array.isArray(expectedMode)?expectedMode:[expectedMode];if(!before.isFile()||before.nlink!==1n||!modes.includes(mode)||before.size>BigInt(Number.MAX_SAFE_INTEGER))throw new Error(`authority file identity/mode rejected: ${file}`);
    afterOpen?.();const size=Number(before.size),bytes=Buffer.alloc(size);let offset=0;while(offset<size){const count=fs.readSync(fd,bytes,offset,Math.min(65536,size-offset),offset);if(count<=0)throw new Error(`authority file truncated: ${file}`);offset+=count}
    const after=fs.fstatSync(fd,{bigint:true});if(!same(before,after))throw new Error(`authority file changed while hashing: ${file}`);const live=fs.lstatSync(file,{bigint:true});if(!live.isFile()||live.isSymbolicLink()||!same(after,live))throw new Error(`authority path identity changed while hashing: ${file}`);return {bytes,mode};
  }finally{fs.closeSync(fd)}
}
export function readStableAuthorityFile(file,expectedMode,afterOpen){return readStableAuthorityFileWithIdentity(file,expectedMode,afterOpen).bytes}
