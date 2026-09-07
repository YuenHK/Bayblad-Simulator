import { it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

it("checks the deployed admin entry, assets, session and one-use probe without relying on JSON file extensions", () => {
  const dir = mkdtempSync(join(tmpdir(), "production-smoke-contract-"));
  try {
    const nonce = "6".repeat(64);
    const requests = join(dir, "requests");
    const secret = join(dir, "credentials");
    writeFileSync(secret, JSON.stringify({ username: "fixture", password: "fixture-password" }), { mode: 0o600 });
    writeFileSync(join(dir, "node"), `#!${process.execPath}
const fs=require("fs"),cp=require("child_process");
const args=process.argv.slice(2);
if(args[0]?.endsWith("production-wss-smoke.mjs")){fs.appendFileSync(process.env.SMOKE_REQUESTS,"WSS\\n");process.exit(0);}
const r=cp.spawnSync(process.execPath,args,{stdio:"inherit"});process.exit(r.status??1);
`, { mode: 0o700 });
    writeFileSync(join(dir, "curl"), `#!${process.execPath}
const fs=require("fs"),args=process.argv.slice(2),url=new URL(args.at(-1)),log=process.env.SMOKE_REQUESTS;
fs.appendFileSync(log,url.pathname+"\\n");
let body="",status=200;
if(url.protocol==="http:"){status=308;}
else if(url.pathname==="/"){status=302;body="Moved to /admin/";}
else if(url.pathname==="/admin/"){body='<html><script src="/admin/assets/app-fixture.js"></script></html>';}
else if(url.pathname==="/api/admin/session"){
  if(fs.existsSync(log+".logout")){status=401;}else{body=JSON.stringify({csrfToken:"fixture-csrf"});}
}else if(url.pathname==="/api/admin/logout"){fs.writeFileSync(log+".logout","");}
else if(url.pathname.startsWith("/api/admin/deployment-probe/")){
  if(fs.existsSync(log+".probe")){status=404;}else{body=JSON.stringify({nonce:url.pathname.split("/").at(-1)});fs.writeFileSync(log+".probe","");}
}else if(!["/admin/assets/app-fixture.js","/health/ready","/api/admin/login"].includes(url.pathname)){process.exit(22);}
const headers=args.indexOf("-D");if(headers>=0)fs.writeFileSync(args[headers+1],"HTTP/1.1 308 Permanent Redirect\\r\\nLocation: https://fixture.test/\\r\\n");
const output=args.indexOf("-o");if(output>=0)fs.writeFileSync(args[output+1],body);else process.stdout.write(body);
if(args.includes("-w"))process.stdout.write(String(status));
`, { mode: 0o700 });
    const result = spawnSync("bash", [resolve("scripts/production-smoke.sh"), "https://fixture.test", nonce], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, ADMIN_SMOKE_SECRET_FILE: secret, SMOKE_REQUESTS: requests },
      encoding: "utf8", timeout: 10_000,
    });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    const observed = readFileSync(requests, "utf8").split("\n");
    expect(observed).toContain("/admin/");
    expect(observed).toContain("/admin/assets/app-fixture.js");
    expect(observed).toContain("WSS");
    expect(observed.filter(path => path === `/api/admin/deployment-probe/${nonce}`)).toHaveLength(2);
    expect(observed.at(-2)).toBe("/api/admin/session");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
