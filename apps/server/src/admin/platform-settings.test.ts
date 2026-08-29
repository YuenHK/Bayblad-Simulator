import { describe, expect, it } from "vitest";
import { AdminAuthService, InMemoryAdminStore, type AuditInput } from "../auth/admin-auth";
import { AdminCommandExecutor } from "./command-executor";
import { InMemoryPlatformSettingsStore } from "./platform-settings";
import { InMemoryAdminCommandStore, adminCommandPayloadHash } from "./command-operations";

describe("durable admin control state", () => {
  it("hydrates the last platform pause value after a new gateway composition", async () => {
    const store = new InMemoryPlatformSettingsStore();
    await store.writePaused(true);
    expect(await store.readPaused()).toBe(true);
  });
  it("replays the same command outcome and rejects operation id payload conflicts", async () => {
    const store = new InMemoryAdminCommandStore(), hash = adminCommandPayloadHash({ action: "platform.pause", paused: true });
    const input={operationId:"550e8400-e29b-41d4-a716-446655440000",payloadHash:hash,action:"platform.pause" as const,target:"platform",payload:{paused:true},adminUserId:"650e8400-e29b-41d4-a716-446655440000",adminSessionId:"750e8400-e29b-41d4-a716-446655440000"};
    expect((await store.accept(input)).created).toBe(true);
    const claimed=await store.claimDue(new Date(),1000);await store.checkpoint(input.operationId,claimed!.leaseToken!,"completed",{});
    const replay = await store.accept(input);
    expect("operation" in replay && replay.operation.status).toBe("completed");
    expect(await store.accept({...input,payloadHash:adminCommandPayloadHash({ action: "platform.pause", paused: false }),payload:{paused:false}})).toEqual({ conflict: true });
  });
  it("retries a final audit without repeating an already applied side effect", async () => {
    class FlakyAuditStore extends InMemoryAdminStore {
      calls = 0;
      override async audit(input: AuditInput) {
        this.calls++;
        if (this.calls === 2) throw new Error("temporary audit failure");
        await super.audit(input);
      }
    }
    const adminStore = new FlakyAuditStore();
    const auth = new AdminAuthService(adminStore, { allowedOrigins: ["http://localhost"] });
    const commands = new InMemoryAdminCommandStore();
    const platform = new InMemoryPlatformSettingsStore();
    let now = new Date("2026-08-29T00:00:00.000Z");
    let closes = 0;
    const executor = new AdminCommandExecutor(commands, auth, {
      setPlatformPaused: () => undefined,
      adminCloseRoom: async () => { closes++; },
      adminRemoveParticipant: async () => undefined,
    }, platform, () => now);
    const operationId = "550e8400-e29b-41d4-a716-446655440001";
    await commands.accept({
      operationId,
      payloadHash: adminCommandPayloadHash({ action: "room.close", roomId: "ABCD" }),
      action: "room.close",
      target: "ABCD",
      payload: { action: "room.close", roomId: "ABCD" },
      adminUserId: "650e8400-e29b-41d4-a716-446655440000",
      adminSessionId: "750e8400-e29b-41d4-a716-446655440000",
    }, now);

    await executor.pump();
    expect((await commands.get(operationId))?.status).toBe("audit_pending");
    expect(closes).toBe(1);

    now = new Date(now.getTime() + 1_000);
    await executor.pump();
    expect((await commands.get(operationId))?.status).toBe("completed");
    expect(closes).toBe(1);
  });
  it("fences stale lease generations and retains accepted commands while the accepted audit is unavailable", async () => {
    const commands = new InMemoryAdminCommandStore();
    let now = new Date("2026-08-29T00:00:00.000Z");
    const input={operationId:"550e8400-e29b-41d4-a716-446655440002",payloadHash:adminCommandPayloadHash({action:"room.close",roomId:"ROOM"}),action:"room.close" as const,target:"ROOM",payload:{action:"room.close",roomId:"ROOM"},adminUserId:"650e8400-e29b-41d4-a716-446655440000",adminSessionId:"750e8400-e29b-41d4-a716-446655440000"};
    await commands.accept(input, now);
    const first = await commands.claimDue(now, 100);
    expect(await commands.renewLease(input.operationId, first!.leaseToken!, first!.leaseGeneration + 1, now, 100)).toBe(false);
    expect(await commands.renewLease(input.operationId, first!.leaseToken!, first!.leaseGeneration, now, 100)).toBe(true);

    class UnavailableAuditStore extends InMemoryAdminStore { override async audit() { throw new Error("audit unavailable"); } }
    const auditStore = new UnavailableAuditStore();
    const auth = new AdminAuthService(auditStore, { allowedOrigins: ["http://localhost"] });
    let closes = 0;
    const executor = new AdminCommandExecutor(commands, auth, { setPlatformPaused:()=>undefined,adminCloseRoom:async()=>{closes++;},adminRemoveParticipant:async()=>undefined }, new InMemoryPlatformSettingsStore(), () => now);
    now = new Date(now.getTime() + 101);
    for (let attempt = 0; attempt < 10; attempt++) { await executor.pump(); now = new Date(now.getTime() + 61_000); }
    expect((await commands.get(input.operationId))?.status).toBe("accepted");
    expect(closes).toBe(0);
  });
  it("resumes terminal failure audit without executing the failed side effect again", async () => {
    class OneFailureAuditStore extends InMemoryAdminStore { failed=false; override async audit(input:AuditInput){if(input.outcome==="failure"&&!this.failed){this.failed=true;throw new Error("audit crash");}await super.audit(input);} }
    const auditStore=new OneFailureAuditStore(),commands=new InMemoryAdminCommandStore(),auth=new AdminAuthService(auditStore,{allowedOrigins:["http://localhost"]});
    let now=new Date("2026-08-29T00:00:00.000Z"),calls=0;
    const executor=new AdminCommandExecutor(commands,auth,{setPlatformPaused:()=>undefined,adminCloseRoom:async()=>{calls++;throw new Error("close failed");},adminRemoveParticipant:async()=>undefined},new InMemoryPlatformSettingsStore(),()=>now);
    const input={operationId:"550e8400-e29b-41d4-a716-446655440005",payloadHash:adminCommandPayloadHash({action:"room.close",roomId:"ROOM"}),action:"room.close" as const,target:"ROOM",payload:{action:"room.close",roomId:"ROOM"},adminUserId:"650e8400-e29b-41d4-a716-446655440000",adminSessionId:"750e8400-e29b-41d4-a716-446655440000"};
    await commands.accept(input,now);
    for(let attempt=0;attempt<7;attempt++){await executor.pump();now=new Date(now.getTime()+61_000);}
    await expect(executor.pump()).rejects.toThrow("audit crash");
    expect((await commands.get(input.operationId))?.result.step).toBe("terminal_audit_pending");
    expect(calls).toBe(8);
    now=new Date(now.getTime()+16_000);await executor.pump();
    expect((await commands.get(input.operationId))?.status).toBe("terminal_failed");
    expect(calls).toBe(8);
  });
});
