import {readFileSync} from "node:fs";import {describe,expect,it} from "vitest";
const workflow=readFileSync(".github/workflows/authorize-rollback.yml","utf8");
describe("protected rollback authorization",()=>{
 it("requires manual environment approval and minimal immutable source inputs",()=>{expect(workflow).toContain("workflow_dispatch:");expect(workflow).toContain("environment: production-rollback-approval");expect(workflow).toContain("previous_run_id");expect(workflow).toContain("previous_manifest_sha256");expect(workflow).not.toContain("candidate");});
 it("verifies both source attestations before preserving the current database image",()=>{expect(workflow.match(/gh attestation verify/gu)?.length).toBe(2);expect(workflow).toContain("create-authorized-rollback.mjs");expect(readFileSync("scripts/create-authorized-rollback.mjs","utf8")).toContain("database:current.images.database");});
 it("attests and uploads a non-hidden deployable artifact with pinned actions",()=>{expect(workflow).toContain("actions/attest-build-provenance@");expect(workflow).toContain("path: release/");expect(workflow).toContain("EXTERNAL-MANIFEST-SHA256");const refs=[...workflow.matchAll(/uses:\s*[^@\s]+@([^\s#]+)/gu)].map(x=>x[1]);expect(refs.every(x=>/^[a-f0-9]{40}$/u.test(x!))).toBe(true);});
});
