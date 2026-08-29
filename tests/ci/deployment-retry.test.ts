import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { describe, expect, it } from "vitest";
const run=promisify(execFile),sha=(x:string)=>`sha256:${x.repeat(64).slice(0,64)}`;

async function classify(change?: (items:any[])=>void) {
  const d=await mkdtemp(join(tmpdir(),"deploy-retry-")),manifest=join(d,"manifest.json"),containers=join(d,"containers.json"),images=join(d,"images.json"),output=join(d,"result.json");
  const refs={server:`ghcr.io/o/r/server@${sha("1")}`,migration:`ghcr.io/o/r/server@${sha("1")}`,web:`ghcr.io/o/r/web@${sha("2")}`,database:`ghcr.io/o/r/database@${sha("3")}`},caddy=`caddy@${sha("4")}`;
  const expected={db:refs.database,migration:refs.server,server:refs.server,web:refs.web,caddy};
  const items=Object.entries(expected).map(([service,image])=>({Config:{Image:image,Labels:{"com.docker.compose.service":service,"com.docker.compose.project":"steam-top-simulator"}},State:service==="migration"?{Status:"exited",ExitCode:0}:{Status:"running",Health:{Status:"healthy"}}}));change?.(items);
  await writeFile(manifest,JSON.stringify({images:refs}));await writeFile(containers,JSON.stringify(items));await writeFile(images,JSON.stringify([...new Set(Object.values(expected))].map((ref,i)=>({Id:sha(String(i+5)),RepoDigests:[ref]}))));
  await run("node",["scripts/classify-host-deployment.mjs",manifest,containers,images,caddy,"production",output]);return JSON.parse(await readFile(output,"utf8"));
}
describe("partial deployment retry classification",()=>{
  it("accepts only a complete exact immutable observation",async()=>expect(await classify()).toEqual({classification:"complete"}));
  it("fails closed on missing or mismatched services",async()=>{expect((await classify(x=>x.pop())).classification).toBe("partial");expect((await classify(x=>x[0].Config.Image="server:mutable")).classification).toBe("partial")});
  it("host core keeps deploying retryable and creates a durable incident for partial state",async()=>{const host=await readFile("scripts/host-deploy-and-receipt.sh","utf8");expect(host).toContain('current_state == deploying');expect(host).toContain("classify-host-deployment.mjs");expect(host).toContain("RECOVERY-REQUIRED");expect(host).toContain("partial deployment observed");});
});
