import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
const execute = promisify(execFile);
const digest = (value: string) => `sha256:${value.repeat(64)}`;

async function fixture(mutable = false) {
  const root = await mkdtemp(join(tmpdir(), "deploy-production-")), artifact = join(root, "artifact"), bin = join(root, "bin"), log = join(root, "docker.log");
  await mkdir(artifact);await mkdir(bin);
  const images={server:`ghcr.io/school/top/steam-top/server@${digest("1")}`,migration:`ghcr.io/school/top/steam-top/server@${digest("1")}`,web:`ghcr.io/school/top/steam-top/web@${digest("2")}`,database:`ghcr.io/school/top/steam-top/database@${digest("3")}`};
  const manifest=JSON.stringify({schemaVersion:1,commit:"a".repeat(40),images},null,2)+"\n";await writeFile(join(artifact,"release-manifest.json"),manifest);
  await writeFile(join(artifact,"SHA256SUMS"),`${createHash("sha256").update(manifest).digest("hex")}  release-manifest.json\n`);
  const env=join(root,"production.env"),base=["PUBLIC_ORIGIN=https://school.example","NODE_IMAGE_REPOSITORY=node",`NODE_IMAGE_DIGEST=${digest("4")}`,"POSTGRES_IMAGE_REPOSITORY=postgres",`POSTGRES_IMAGE_DIGEST=${digest("5")}`,"CADDY_IMAGE_REPOSITORY=caddy",`CADDY_IMAGE_DIGEST=${digest("6")}`,`SERVER_IMAGE=${mutable?"steam-top-server:latest":images.server}`,`WEB_IMAGE=${images.web}`,`DATABASE_IMAGE=${images.database}`];await writeFile(env,base.join("\n")+"\n");
  const docker=join(bin,"docker");await writeFile(docker,'#!/bin/sh\nprintf "%s\\n" "$*" >> "$DOCKER_LOG"\n',{mode:0o755});await chmod(docker,0o755);
  for(const [name,body] of [["gh",'#!/bin/sh\n[ "$1 $2" = "attestation verify" ]\n'],["stat",'#!/bin/sh\np="${@: -1}"\ncase "$p" in *production.env) echo "0 600";; *) echo "0 755";; esac\n']] as const){const path=join(bin,name);await writeFile(path,body,{mode:0o755});await chmod(path,0o755);}
  return {artifact,env,log,manifestSha:createHash("sha256").update(manifest).digest("hex"),processEnv:{...process.env,PATH:`${bin}:${process.env.PATH}`,DOCKER_LOG:log}};
}
describe("production deploy wrapper",()=>{
  it("rejects a mutable tag before invoking Compose",async()=>{const f=await fixture(true);await expect(execute("./scripts/deploy-production.sh",[f.artifact,f.env,f.manifestSha,"school/top","a".repeat(40)],{env:f.processEnv,shell:"/bin/bash"})).rejects.toBeTruthy();await expect(readFile(f.log,"utf8")).rejects.toMatchObject({code:"ENOENT"});});
  it("runs config, pull and up only after exact external authorization binding",async()=>{const f=await fixture();await execute("./scripts/deploy-production.sh",[f.artifact,f.env,f.manifestSha,"school/top","a".repeat(40)],{env:f.processEnv,shell:"/bin/bash"});const calls=await readFile(f.log,"utf8");expect(calls.indexOf(" config --quiet")).toBeLessThan(calls.indexOf(" pull"));expect(calls.indexOf(" pull")).toBeLessThan(calls.indexOf(" up -d --wait"));});
  it("rejects a manifest digest not supplied by the artifact itself",async()=>{const f=await fixture();await expect(execute("./scripts/deploy-production.sh",[f.artifact,f.env,"f".repeat(64),"school/top","a".repeat(40)],{env:f.processEnv,shell:"/bin/bash"})).rejects.toBeTruthy();});
});
