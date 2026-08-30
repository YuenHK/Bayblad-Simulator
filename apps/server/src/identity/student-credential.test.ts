import { describe, expect, it } from "vitest";
import { StudentCredentialService } from "./student-credential";

describe("student credential", () => {
  it("binds a signed identity token to audience, origin, key id and a maximum 12 hour lifetime", () => {
    let now=1_000_000;const origin="https://school.github.io",token="t".repeat(43);
    const service=new StudentCredentialService({keys:{old:Buffer.alloc(32,1),current:Buffer.alloc(32,2)},activeKeyId:"current",origin,now:()=>now});
    const credential=service.issue(token);expect(service.verify(credential,origin)).toBe(token);expect(service.verify(credential,"https://evil.example")).toBeUndefined();
    const tampered=`${credential.slice(0,-1)}${credential.endsWith("a")?"b":"a"}`;expect(service.verify(tampered,origin)).toBeUndefined();
    now+=43_200_001;expect(service.verify(credential,origin)).toBeUndefined();
  });
});
