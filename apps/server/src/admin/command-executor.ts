import { durableAudit, type AdminAuthService } from "../auth/admin-auth";
import type { AdminRealtimeCommands } from "./dashboard-routes";
import type { PlatformSettingsStore } from "./platform-settings";
import type { AdminCommandOperation, AdminCommandStore } from "./command-operations";

const LEASE_MS = 15_000;

export class AdminCommandExecutor {
  #running = false;
  constructor(private readonly store: AdminCommandStore, private readonly auth: AdminAuthService, private readonly realtime: AdminRealtimeCommands, private readonly platform: PlatformSettingsStore, private readonly now = () => new Date()) {}

  async pump(limit = 16, reportStage?: (stage: string) => void) {
    if (this.#running) return;
    this.#running = true;
    try { reportStage?.("admin-command-prune"); await this.store.pruneTerminal?.(this.now(), 100); for (let index = 0; index < limit; index++) { reportStage?.("admin-command-claim"); const operation = await this.store.claimDue(this.now(), LEASE_MS); if (!operation) break; reportStage?.("admin-command-execute"); await this.#execute(operation); } }
    finally { this.#running = false; }
  }

  async #execute(operation: AdminCommandOperation) {
    const token = operation.leaseToken!;
    let applied = operation.result.step === "applied";
    let acceptedAudited = applied || operation.result.step === "accepted_audited" || typeof operation.result.step === "string" && operation.action === "room.remove";
    let partialStep = typeof operation.result.step === "string" && operation.result.step !== "applied" ? operation.result.step : undefined;
    const controller = new AbortController();
    let renewing = false;
    const timer = setInterval(() => {
      if (renewing) return;
      renewing = true;
      void this.store.renewLease(operation.operationId, token, operation.leaseGeneration, this.now(), LEASE_MS)
        .then((renewed) => { if (!renewed) controller.abort(); }, () => controller.abort())
        .finally(() => { renewing = false; });
    }, LEASE_MS / 3);
    timer.unref();
    try {
      if (operation.result.step === "terminal_audit_pending") {
        await durableAudit(this.auth.store, { adminUserId: operation.adminUserId, adminSessionId: operation.adminSessionId, action: `admin.${operation.action}`, outcome: "failure", details: { operationId: operation.operationId, target: operation.target, step: operation.result.failureStep ?? "safe_failure", ...(operation.result.lastCompletedStep ? { lastCompletedStep: operation.result.lastCompletedStep } : {}) } });
        await this.store.checkpoint(operation.operationId, token, "terminal_failed", { status: "terminal_failed", step: operation.result.failureStep ?? "safe_failure", ...(operation.result.lastCompletedStep ? { lastCompletedStep: operation.result.lastCompletedStep } : {}) });
        return;
      }
      if (!applied) {
        if (!acceptedAudited) {
          await durableAudit(this.auth.store, { adminUserId: operation.adminUserId, adminSessionId: operation.adminSessionId, action: "admin.room.command.accepted", outcome: "success", details: { operationId: operation.operationId, action: operation.action, target: operation.target } });
          acceptedAudited = await this.store.progress(operation.operationId, token, operation.leaseGeneration, { status: "pending", step: "accepted_audited" }, this.now());
          if (!acceptedAudited) controller.abort();
          partialStep = "accepted_audited";
        }
        const fence = async (completedStep?: string) => {
          if (controller.signal.aborted) throw new Error("ADMIN_COMMAND_LEASE_LOST");
          if (completedStep) {
            partialStep = completedStep;
            if (!await this.store.progress(operation.operationId, token, operation.leaseGeneration, { status: "pending", step: completedStep }, this.now())) controller.abort();
          }
          if (!await this.store.renewLease(operation.operationId, token, operation.leaseGeneration, this.now(), LEASE_MS)) controller.abort();
          if (controller.signal.aborted) throw new Error("ADMIN_COMMAND_LEASE_LOST");
        };
        await fence();
        if (operation.action === "platform.pause") {
          const paused = operation.payload.paused === true;
          await this.platform.writePaused(paused);
          if (controller.signal.aborted) throw new Error("ADMIN_COMMAND_LEASE_LOST");
          this.realtime.setPlatformPaused(paused);
        } else if (operation.action === "room.close") await this.realtime.adminCloseRoom(String(operation.payload.roomId), controller.signal);
        else await this.realtime.adminRemoveParticipant(String(operation.payload.roomId), String(operation.payload.participantId), { signal: controller.signal, ...(partialStep ? { currentStep: partialStep } : {}), fence });
        if (controller.signal.aborted) throw new Error("ADMIN_COMMAND_LEASE_LOST");
        applied = true;
        await this.store.checkpoint(operation.operationId, token, "applied", { status: "pending", step: "applied" }, this.now());
        return;
      }
      await durableAudit(this.auth.store, { adminUserId: operation.adminUserId, adminSessionId: operation.adminSessionId, action: `admin.${operation.action}`, outcome: "success", details: { operationId: operation.operationId, action: operation.action, target: operation.target } });
      await this.store.checkpoint(operation.operationId, token, "completed", { status: "completed" });
    } catch (error) {
      this.auth.report("admin.command.executor", error);
      if (controller.signal.aborted) return;
      const next = new Date(this.now().getTime() + Math.min(60_000, 250 * 2 ** operation.attempts));
      const failed = operation.attempts >= 8 && acceptedAudited && !applied;
      const failureStep = partialStep ? "applied_partial" : "safe_failure";
      if (failed) {
        const pending = { status: "pending", step: "terminal_audit_pending", failureStep, ...(partialStep ? { lastCompletedStep: partialStep } : {}) };
        if (!await this.store.progress(operation.operationId, token, operation.leaseGeneration, pending, this.now())) return;
        await durableAudit(this.auth.store, { adminUserId: operation.adminUserId, adminSessionId: operation.adminSessionId, action: `admin.${operation.action}`, outcome: "failure", details: { operationId: operation.operationId, target: operation.target, step: failureStep, ...(partialStep ? { lastCompletedStep: partialStep } : {}) } });
        await this.store.checkpoint(operation.operationId, token, "terminal_failed", { status: "terminal_failed", step: failureStep, ...(partialStep ? { lastCompletedStep: partialStep } : {}) }, next);
      } else await this.store.checkpoint(operation.operationId, token, applied ? "audit_pending" : "accepted", { status: "pending", ...(partialStep ? { step: partialStep } : applied ? { step: "applied" } : {}) }, next);
    } finally { clearInterval(timer); }
  }
}
