import {readFileSync,statSync} from "node:fs";
import {resolve} from "node:path";
import {spawnSync} from "node:child_process";
const [frame,nonce,incident,allowed,signer]=process.argv.slice(2);if(!frame||!/^[a-f0-9]{64}$/.test(nonce)||!incident?.startsWith("/")||!allowed?.startsWith("/")||!/^[A-Za-z0-9@._-]+$/.test(signer))process.exit(2);
const raw=readFileSync(frame,"utf8"),x=JSON.parse(raw),expected=`${resolve(incident)}/confirmed/${nonce}/final.json`;
if(raw.trim().split("\n").length!==1||Object.keys(x).sort().join("|")!==["promotionNonce","purpose","receiptPath","schemaVersion","signaturePath"].sort().join("|")||x.schemaVersion!==1||x.purpose!=="confirmed-cutover"||x.promotionNonce!==nonce||x.receiptPath!==expected||x.signaturePath!==`${expected}.sig`)process.exit(1);
for(const p of [x.receiptPath,x.signaturePath]){const s=statSync(p,{throwIfNoEntry:false});if(!s?.isFile()||s.uid!==0||(s.mode&0o777)!==0o400)process.exit(1)}
const verified=spawnSync("ssh-keygen",["-Y","verify","-q","-f",allowed,"-I",signer,"-n","steam-top-public-cutover-smoke","-s",x.signaturePath],{input:readFileSync(x.receiptPath)});if(verified.status!==0)process.exit(1);process.stdout.write(`${x.receiptPath}\t${x.signaturePath}\n`);
