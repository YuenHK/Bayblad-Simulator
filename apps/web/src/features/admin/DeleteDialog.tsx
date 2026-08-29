import { useState } from "react";
import { AdminModal } from "./AdminModal";
import { AdminApiError, jsonHeaders, requestJson } from "./api";
import type { AdminFilters } from "./RecordsTable";
import type { Fetcher } from "./types";
type Preview = {
  previewToken: string;
  filterHash: string;
  expiresAt: string;
  counts: { identities: number; designs: number; matches: number };
};
type Scope = "all" | "class" | "identity" | "date_range";
export function DeleteDialog({
  fetcher,
  csrf,
  filters,
  identities,
  onDeleted,
  onClose,
  onUnauthorized,
}: {
  fetcher: Fetcher;
  csrf: string;
  filters: AdminFilters;
  identities: readonly Readonly<{ id: string; displayName: string; className: string | null; deviceName: string | null }>[];
  onDeleted: () => Promise<void>;
  onClose: () => void;
  onUnauthorized: () => void;
}) {
  const [scope, setScope] = useState<Scope>(
      identities.length ? "identity" : "date_range",
    ),
    [identityId, setIdentityId] = useState(identities[0]?.id ?? ""),
    [password, setPassword] = useState(""),
    [confirmation, setConfirmation] = useState(""),
    [preview, setPreview] = useState<Preview | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const filter =
    scope === "class"
      ? { scope, className: filters.className }
      : scope === "identity"
        ? { scope, identityId }
        : scope === "date_range"
          ? { scope, from: filters.from, to: filters.to }
          : { scope };
  const valid =
    scope === "all" ||
    scope === "date_range" ||
    (scope === "class" && Boolean(filters.className)) ||
    (scope === "identity" && Boolean(identityId));
  return (
    <AdminModal title="刪除紀錄" onClose={busy ? () => undefined : onClose}>
      <p className="field-error">
        此操作不可還原，並會留下不可修改的稽核紀錄。
      </p>
      <label>
        刪除範圍
        <select
          value={scope}
          onChange={(event) => {
            setScope(event.target.value as Scope);
            setPreview(null);
          }}
        >
          <option value="date_range">目前日期範圍</option>
          <option value="class" disabled={!filters.className}>
            目前班別
            {filters.className
              ? `：${filters.className}`
              : "（先在紀錄篩選選擇）"}
          </option>
          <option value="identity" disabled={!identities.length}>
            從紀錄選取的學生
          </option>
          <option value="all">全部紀錄</option>
        </select>
      </label>
      {scope === "identity" ? (
        <label>
          已選學生
          <select
            value={identityId}
            onChange={(event) => setIdentityId(event.target.value)}
          >
            {identities.map((identity) => (
              <option key={identity.id} value={identity.id}>
                {identity.displayName}（{identity.className ?? "未有班別"}；{identity.deviceName ?? "未有裝置名稱"}）
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <button
        onClick={async () => {
          setBusy(true);
          setError("");
          try {
            setPreview(
              await requestJson(
                fetcher,
                "/api/admin/records/deletion-preview",
                {
                  method: "POST",
                  headers: jsonHeaders(csrf),
                  body: JSON.stringify(filter),
                },
              ),
            );
          } catch (reason) {
            if (reason instanceof AdminApiError && reason.status === 401) onUnauthorized();
            setError("未能建立刪除預覽。");
          } finally {
            setBusy(false);
          }
        }}
        disabled={busy || !valid}
      >
        預覽刪除範圍
      </button>
      {preview ? (
        <>
          <p role="status">
            範圍：{scope === "all" ? "全部紀錄" : scope === "class" ? `班別 ${filters.className}` : scope === "identity" ? `學生 ${identities.find((item) => item.id === identityId)?.displayName ?? "已選學生"}` : `${filters.from} 至 ${filters.to}`}。{" "}
            將刪除 {preview.counts.identities} 個身份、{preview.counts.designs}{" "}
            個設計、{preview.counts.matches} 場對戰。
          </p>
          <label>
            再次輸入管理員密碼
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          <label>
            輸入 DELETE 確認
            <input
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
            />
          </label>
          <button
            className="danger-button"
            disabled={busy || password.length < 8 || confirmation !== "DELETE"}
            onClick={async () => {
              setBusy(true);
              setError("");
              try {
                await requestJson(fetcher, "/api/admin/records", {
                  method: "DELETE",
                  headers: jsonHeaders(csrf),
                  body: JSON.stringify({
                    previewToken: preview.previewToken,
                    filterHash: preview.filterHash,
                    password,
                    confirmation,
                  }),
                });
                setPassword("");
                setConfirmation("");
                setPreview(null);
                await onDeleted();
                onClose();
              } catch (reason) {
                if (reason instanceof AdminApiError && reason.status === 401) onUnauthorized();
                setPreview(null);
                setError("刪除失敗；請重新預覽。");
              } finally {
                setPassword("");
                setBusy(false);
              }
            }}
          >
            永久刪除
          </button>
        </>
      ) : null}
      {error ? (
        <p role="alert" className="field-error">
          {error}
        </p>
      ) : null}
      <button disabled={busy} onClick={onClose}>
        取消
      </button>
    </AdminModal>
  );
}
