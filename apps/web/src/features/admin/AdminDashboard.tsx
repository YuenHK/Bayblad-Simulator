import { useCallback, useEffect, useRef, useState } from "react";
import {
  adminAnalyticsSummarySchema,
  adminRecordsPageSchema,
} from "@steam-top/protocol";
import { AdminModal } from "./AdminModal";
import { AdminApiError, jsonHeaders, requestJson } from "./api";
import { AnalyticsCharts } from "./AnalyticsCharts";
import { DeleteDialog } from "./DeleteDialog";
import { filterParams, RecordsTable, type AdminFilters } from "./RecordsTable";
import { RoomsPanel } from "./RoomsPanel";
import type {
  AdminSession,
  AnalyticsResponse,
  Fetcher,
  RecordsResponse,
  RoomsResponse,
} from "./types";
const hkDate = (date: Date) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Hong_Kong",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
const shiftIsoDate = (value: string, days: number) => {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};
const initialFilters = (): AdminFilters => {
  const now = new Date(),
    from = new Date(now.getTime() - 30 * 86_400_000);
  return {
    from: hkDate(from),
    to: hkDate(now),
    className: "",
    identity: "",
    device: "",
    parameter: "",
    page: 1,
    pageSize: 25,
  };
};
const emptyRecords: RecordsResponse = {
  rows: [],
  total: 0,
  page: 1,
  pageSize: 25,
};
export function AdminDashboard({
  fetcher,
  session,
  onUnauthorized,
}: {
  fetcher: Fetcher;
  session: AdminSession;
  onUnauthorized: () => void;
}) {
  const [rooms, setRooms] = useState<RoomsResponse>({
      paused: false,
      rooms: [],
    }),
    [records, setRecords] = useState<RecordsResponse>(emptyRecords),
    [analytics, setAnalytics] = useState<AnalyticsResponse | null>(null),
    [filters, setFilters] = useState(initialFilters),
    [selected, setSelected] = useState<Set<string>>(new Set()),
    [error, setError] = useState(""),
    [confirm, setConfirm] = useState<{
      action: string;
      payload: object;
      label: string;
    } | null>(null),
    [password, setPassword] = useState(""),
    [mutationBusy, setMutationBusy] = useState(false),
    [deleteOpen, setDeleteOpen] = useState(false),
    [exportStatus, setExportStatus] = useState("");
  const exportController = useRef<AbortController | null>(null);
  const guarded = useCallback(
    async <T,>(operation: () => Promise<T>) => {
      try {
        return await operation();
      } catch (reason) {
        if (reason instanceof AdminApiError && reason.status === 401)
          onUnauthorized();
        throw reason;
      }
    },
    [onUnauthorized],
  );
  const query = useCallback(
    async (next: AdminFilters) => {
      setError("");
      const params = filterParams(next),
        analyticsParams = new URLSearchParams({ from: next.from, to: next.to });
      if (next.className) analyticsParams.set("className", next.className);
      try {
        const [roomPage, recordPage, summary] = await Promise.all([
          guarded(() =>
            requestJson<RoomsResponse>(fetcher, "/api/admin/rooms"),
          ),
          guarded(() =>
            requestJson(
              fetcher,
              `/api/admin/records?${params}`,
              undefined,
              adminRecordsPageSchema,
            ),
          ),
          guarded(() =>
            requestJson(
              fetcher,
              `/api/admin/analytics?${analyticsParams}`,
              undefined,
              adminAnalyticsSummarySchema,
            ),
          ),
        ]);
        setRooms(roomPage);
        setRecords(recordPage);
        setAnalytics(summary);
      } catch (reason) {
        setError(
          reason instanceof AdminApiError &&
            reason.message === "INVALID_SERVER_RESPONSE"
            ? "伺服器回傳的後台資料格式不正確。"
            : "後台資料暫時無法載入。",
        );
      }
    },
    [fetcher, guarded],
  );
  useEffect(() => {
    void query(filters);
  }, [filters, query]);
  useEffect(() => {
    const timer = window.setInterval(
      () =>
        void guarded(() =>
          requestJson<RoomsResponse>(fetcher, "/api/admin/rooms"),
        )
          .then(setRooms)
          .catch(() => undefined),
      5_000,
    );
    return () => window.clearInterval(timer);
  }, [fetcher, guarded]);
  useEffect(() => () => exportController.current?.abort(), []);
  const mutate = (action: string, payload: object, label: string) => {
    if (!mutationBusy) setConfirm({ action, payload, label });
  };
  const runMutation = async () => {
    if (!confirm || mutationBusy) return;
    setMutationBusy(true);
    try {
      await guarded(() =>
        requestJson(fetcher, "/api/admin/rooms/actions", {
          method: "POST",
          headers: jsonHeaders(session.csrfToken),
          body: JSON.stringify({
            action: confirm.action,
            ...confirm.payload,
            password,
            operationId: crypto.randomUUID(),
          }),
        }),
      );
      setConfirm(null);
      await query(filters);
    } catch {
      setError("管理操作失敗，房間狀態未更改。");
    } finally {
      setPassword("");
      setMutationBusy(false);
    }
  };
  const exportXlsx = async () => {
    if (exportController.current) return;
    const controller = new AbortController();
    exportController.current = controller;
    setExportStatus("正在準備 Excel……");
    let url: string | null = null;
    try {
      const params = new URLSearchParams({
        from: filters.from,
        to: filters.to,
      });
      if (filters.className) params.set("className", filters.className);
      const response = await fetcher(`/api/admin/export.xlsx?${params}`, {
        credentials: "same-origin",
        signal: controller.signal,
      });
      if (response.status === 401) {
        onUnauthorized();
        return;
      }
      if (!response.ok) throw new Error();
      url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = `STEAM-top-${filters.from}-${filters.to}.xlsx`;
      link.click();
      setExportStatus("Excel 已下載。");
    } catch (reason) {
      if (!(reason instanceof DOMException && reason.name === "AbortError"))
        setExportStatus("Excel 匯出失敗，請稍後重試。");
    } finally {
      if (url) URL.revokeObjectURL(url);
      exportController.current = null;
    }
  };
  const logout = async () => {
    if (mutationBusy) return;
    setMutationBusy(true);
    try {
      await requestJson(fetcher, "/api/admin/logout", {
        method: "POST",
        headers: jsonHeaders(session.csrfToken),
        body: "{}",
      });
      setRecords(emptyRecords);
      setAnalytics(null);
      setRooms({ paused: false, rooms: [] });
      setSelected(new Set());
      onUnauthorized();
    } finally {
      setMutationBusy(false);
    }
  };
  return (
    <main className="admin-shell">
      <header className="admin-header">
        <div>
          <p className="eyebrow">教師後台</p>
          <h1>教師控制台</h1>
          <p>已登入：{session.username}</p>
        </div>
        <div className="admin-header-actions">
          <button
            disabled={Boolean(exportController.current)}
            onClick={exportXlsx}
          >
            匯出 Excel
          </button>
          <button className="danger-button" onClick={() => setDeleteOpen(true)}>
            刪除紀錄
          </button>
          <button disabled={mutationBusy} onClick={logout}>
            登出
          </button>
        </div>
      </header>
      <section
        className="panel admin-section admin-date-filter"
        aria-label="統一查詢日期"
      >
        <label>
          開始日期
          <input
            type="date"
            value={filters.from}
            min={shiftIsoDate(filters.to, -366)}
            max={filters.to}
            onChange={(event) =>
              setFilters({ ...filters, from: event.target.value, page: 1 })
            }
          />
        </label>
        <label>
          結束日期
          <input
            type="date"
            value={filters.to}
            min={filters.from}
            max={
              shiftIsoDate(filters.from, 366) < hkDate(new Date())
                ? shiftIsoDate(filters.from, 366)
                : hkDate(new Date())
            }
            onChange={(event) =>
              setFilters({ ...filters, to: event.target.value, page: 1 })
            }
          />
        </label>
      </section>
      {error ? (
        <p className="system-banner error" role="alert">
          {error}
        </p>
      ) : null}
      {exportStatus ? (
        <p role="status" className="system-banner">
          {exportStatus}
        </p>
      ) : null}
      <RoomsPanel rooms={rooms.rooms} paused={rooms.paused} mutate={mutate} />
      <RecordsTable
        data={records}
        filters={filters}
        onFilters={setFilters}
        selectedIdentities={selected}
        onSelectIdentity={(id, isSelected) =>
          setSelected((current) => {
            const next = new Set(current);
            if (isSelected) next.add(id);
            else next.delete(id);
            return next;
          })
        }
      />
      {analytics ? (
        <AnalyticsCharts data={analytics} />
      ) : (
        <p role="status">正在載入統計……</p>
      )}
      {confirm ? (
        <AdminModal
          title="確認管理操作"
          onClose={
            mutationBusy
              ? () => undefined
              : () => {
                  setPassword("");
                  setConfirm(null);
                }
          }
        >
          <p>確定要{confirm.label}？此操作會寫入稽核紀錄。</p>
          <label>
            再次輸入管理員密碼
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          <button
            className="danger-button"
            onClick={runMutation}
            disabled={mutationBusy || password.length < 8}
          >
            {mutationBusy ? "處理中……" : "確認"}
          </button>
          <button
            disabled={mutationBusy}
            onClick={() => {
              setPassword("");
              setConfirm(null);
            }}
          >
            取消
          </button>
        </AdminModal>
      ) : null}
      {deleteOpen ? (
        <DeleteDialog
          fetcher={fetcher}
          csrf={session.csrfToken}
          filters={filters}
          identityIds={[...selected]}
          onDeleted={async () => {
            setRecords(emptyRecords);
            setAnalytics(null);
            setSelected(new Set());
            await query(filters);
          }}
          onClose={() => setDeleteOpen(false)}
        />
      ) : null}
    </main>
  );
}
