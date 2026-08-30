import { describe,expect,it } from "vitest";
import { parseProductionEnv } from "../../scripts/production-env.mjs";
import { validateDeploymentValues } from "../../scripts/validate-deployment-env.mjs";
describe("production env grammar",()=>{
 it.each([" SERVER_IMAGE=x","SERVER_IMAGE =x","SERVER_IMAGE='x'","SERVER_IMAGE=${X}","export SERVER_IMAGE=x","server_image=x","UNKNOWN=x","SERVER_IMAGE=x\nSERVER_IMAGE=y"])("rejects ambiguous or unsupported input %s",value=>expect(()=>parseProductionEnv(value)).toThrow());
 it("accepts comments and exact assignments",()=>expect(parseProductionEnv("# managed\nSERVER_IMAGE=repo@sha256:"+"a".repeat(64)+"\n").SERVER_IMAGE).toContain("repo@sha256:"));
 it("requires separate owner migration and non-owner application identities",()=>{const digest="sha256:"+"a".repeat(64),values={PUBLIC_ORIGIN:"https://top.example",SERVER_IMAGE:`repo/server@${digest}`,WEB_IMAGE:`repo/web@${digest}`,DATABASE_IMAGE:`repo/db@${digest}`,NODE_IMAGE_REPOSITORY:"node",NODE_IMAGE_DIGEST:digest,POSTGRES_IMAGE_REPOSITORY:"postgres",POSTGRES_IMAGE_DIGEST:digest,CADDY_IMAGE_REPOSITORY:"caddy",CADDY_IMAGE_DIGEST:digest,DATABASE_URL:"postgresql://owner:owner@db:5432/steam_top?sslmode=require",APP_DATABASE_URL:"postgresql://steam_top_app:app-secret@db:5432/steam_top?sslmode=require",APP_DATABASE_PASSWORD:"app-secret"};expect(()=>validateDeploymentValues(values)).not.toThrow();expect(()=>validateDeploymentValues({...values,DATABASE_URL:values.APP_DATABASE_URL})).toThrow(/separate/u);});
});
