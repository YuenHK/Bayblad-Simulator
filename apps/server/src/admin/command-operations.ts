import { createHash } from "node:crypto";
import type { DatabaseClient } from "@steam-top/db";

export type AdminCommandStatus = "accepted" | "applied" | "audit_pending" | "completed" | "failed";
export type AdminCommandOperation = Readonly<{ operationId: string; payloadHash: string; status: AdminCommandStatus; httpStatus: number; response: Readonly<Record<string, unknown>> }>;
export interface AdminCommandStore {
  accept(operationId: string, payloadHash: string): Promise<{ created: boolean; operation: AdminCommandOperation } | { conflict: true }>;
  update(operationId: string, status: AdminCommandStatus, httpStatus: number, response?: Readonly<Record<string, unknown>>): Promise<AdminCommandOperation>;
}
export const adminCommandPayloadHash = (payload: unknown) => createHash("sha256").update(JSON.stringify(payload)).digest("hex");

export class InMemoryAdminCommandStore implements AdminCommandStore {
  readonly operations = new Map<string, AdminCommandOperation>();
  async accept(operationId: string, payloadHash: string) {
    const current = this.operations.get(operationId);
    if (current) return current.payloadHash === payloadHash ? { created: false, operation: current } : { conflict: true as const };
    const operation = { operationId, payloadHash, status: "accepted" as const, httpStatus: 202, response: { status: "accepted" } };
    this.operations.set(operationId, operation); return { created: true, operation };
  }
  async update(operationId: string, status: AdminCommandStatus, httpStatus: number, response: Readonly<Record<string, unknown>> = { status }) {
    const current = this.operations.get(operationId); if (!current) throw new Error("ADMIN_COMMAND_NOT_ACCEPTED");
    const next = { ...current, status, httpStatus, response }; this.operations.set(operationId, next); return next;
  }
}

export class PostgresAdminCommandStore implements AdminCommandStore {
  constructor(private readonly client: DatabaseClient) {}
  async accept(operationId: string, payloadHash: string) {
    const rows = await this.client.sql.unsafe("insert into admin_command_operations(operation_id,payload_hash,status,http_status,response_json) values($1,$2,'accepted',202,'{\"status\":\"accepted\"}'::jsonb) on conflict(operation_id) do nothing returning operation_id",[operationId,payloadHash]) as readonly Record<string,unknown>[];
    const current = await this.#get(operationId); if (current.payloadHash !== payloadHash) return { conflict: true as const };
    return { created: rows.length > 0, operation: current };
  }
  async update(operationId: string,status: AdminCommandStatus,httpStatus:number,response:Readonly<Record<string,unknown>>={status}) {
    await this.client.sql.unsafe("update admin_command_operations set status=$2,http_status=$3,response_json=$4::jsonb,updated_at=now() where operation_id=$1",[operationId,status,httpStatus,JSON.stringify(response)]); return this.#get(operationId);
  }
  async #get(operationId:string):Promise<AdminCommandOperation>{ const rows=await this.client.sql.unsafe("select operation_id,payload_hash,status,http_status,response_json from admin_command_operations where operation_id=$1",[operationId]) as readonly Record<string,unknown>[];const row=rows[0];if(!row)throw new Error("ADMIN_COMMAND_NOT_FOUND");return{operationId:String(row.operation_id),payloadHash:String(row.payload_hash),status:row.status as AdminCommandStatus,httpStatus:Number(row.http_status),response:row.response_json as Readonly<Record<string,unknown>>}; }
}
