import {createHash} from "node:crypto";
import {mkdtempSync,readFileSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {spawnSync} from "node:child_process";
import {it,expect} from "vitest";

// Exact producer source: 61aa4db^ (8597a52d1573129a266c1073fac5e290c4fdca58):scripts/create-cutover-receipt.mjs
it("accepts the historical one-stage byte schema and string smoke result",()=>{
  const d=mkdtempSync(join(tmpdir(),"legacy-cutover-")),nonce="a".repeat(64),target="00000000-0000-4000-8000-000000000001",ready=join(d,"ready"),receipt=join(d,"receipt");
  writeFileSync(ready,JSON.stringify({schemaVersion:2,promotionNonce:nonce,systemIdentifier:"1",database:"steam_top",appRole:"steam_top_app",restoreTargetId:target,ledgerRows:0}));
  const readySha=createHash("sha256").update(readFileSync(ready)).digest("hex");
  const base={schemaVersion:2,purpose:"production",readySha256:readySha,systemIdentifier:"1",database:"steam_top",appRole:"steam_top_app",restoreTargetId:target,ledgerRows:0,databaseUrlSha256:"b".repeat(64),deploymentManifestSha256:"c".repeat(64),publicOrigin:"https://steam-top.test",publicSmoke:"passed",promotionNonce:nonce,createdAt:"2026-01-01T00:00:00.000Z"};
  writeFileSync(receipt,JSON.stringify(base,null,2)+"\n");const snapshot=readFileSync(receipt,"utf8");
  const run=()=>spawnSync(process.execPath,["scripts/validate-legacy-cutover-evidence.mjs",receipt,ready,nonce]);
  expect(run().status).toBe(0);expect(readFileSync(receipt,"utf8")).toBe(snapshot);
  writeFileSync(receipt,JSON.stringify({...base,publicSmoke:true}));expect(run().status).not.toBe(0);
  writeFileSync(receipt,JSON.stringify({...base,nonce}));expect(run().status).not.toBe(0);
});
