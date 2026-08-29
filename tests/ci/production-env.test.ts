import { describe,expect,it } from "vitest";
import { parseProductionEnv } from "../../scripts/production-env.mjs";
describe("production env grammar",()=>{
 it.each([" SERVER_IMAGE=x","SERVER_IMAGE =x","SERVER_IMAGE='x'","SERVER_IMAGE=${X}","export SERVER_IMAGE=x","server_image=x","UNKNOWN=x","SERVER_IMAGE=x\nSERVER_IMAGE=y"])("rejects ambiguous or unsupported input %s",value=>expect(()=>parseProductionEnv(value)).toThrow());
 it("accepts comments and exact assignments",()=>expect(parseProductionEnv("# managed\nSERVER_IMAGE=repo@sha256:"+"a".repeat(64)+"\n").SERVER_IMAGE).toContain("repo@sha256:"));
});
