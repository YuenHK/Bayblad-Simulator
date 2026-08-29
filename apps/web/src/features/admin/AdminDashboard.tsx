import { useCallback, useEffect, useState } from "react";
import { AdminApiError, jsonHeaders, requestJson } from "./api";
import { AnalyticsCharts } from "./AnalyticsCharts";
import { DeleteDialog } from "./DeleteDialog";
import { RecordsTable } from "./RecordsTable";
import { RoomsPanel } from "./RoomsPanel";
import type {
  AdminSession,
  AnalyticsResponse,
  Fetcher,
  RecordsResponse,
  RoomsResponse,
} from "./types";
const emptyRecords: RecordsResponse = {
  rows: [],
  total: 0,
  page: 1,
  pageSize: 25,
};
const emptyAnalytics: AnalyticsResponse = {
  usagePeriods: { daily: [], weekly: [], monthly: [] },
  parameterUsage: [],
  rankings: { top: [], bottom: [], overallLaunchDistribution: {} },
  refreshedAt: "",
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
    [records, setRecords] = useState(emptyRecords),
    [analytics, setAnalytics] = useState(emptyAnalytics),
    [error, setError] = useState(""),
    [confirm, setConfirm] = useState<{
      action: string;
      payload: object;
      label: string;
    } | null>(null),
    [actionPassword, setActionPassword] = useState(""),
    [deleteOpen, setDeleteOpen] = useState(false),
    [exportStatus, setExportStatus] = useState("");
  const guarded = useCallback(
    async <T,>(op: () => Promise<T>) => {
      try {
        return await op();
      } catch (e) {
        if (e instanceof AdminApiError && e.status === 401) onUnauthorized();
        throw e;
      }
    },
    [onUnauthorized],
  );
  const refresh = useCallback(async () => {
    setError("");
    try {
      const [r, rec, a] = await Promise.all([
        guarded(() => requestJson<RoomsResponse>(fetcher, "/api/admin/rooms")),
        guarded(() =>
          requestJson<RecordsResponse>(
            fetcher,
            "/api/admin/records?page=1&pageSize=25",
          ),
        ),
        guarded(() =>
          requestJson<AnalyticsResponse>(
            fetcher,
            "/api/admin/analytics?from=2026-01-01&to=2026-12-31",
          ),
        ),
      ]);
      setRooms(r);
      setRecords(rec);
      setAnalytics(a);
    } catch {
      setError("後台資料暫時無法載入。");
    }
  }, [fetcher, guarded]);
  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => {
      void guarded(() => requestJson<RoomsResponse>(fetcher, "/api/admin/rooms"))
        .then(setRooms)
        .catch(() => undefined);
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [fetcher, guarded, refresh]);
  const mutate = (action: string, payload: object, label: string) =>
    setConfirm({ action, payload, label });
  const runMutation = async () => {
    if (!confirm) return;
    try {
      await guarded(() =>
        requestJson(fetcher, "/api/admin/rooms/actions", {
          method: "POST",
          headers: jsonHeaders(session.csrfToken),
          body: JSON.stringify({ action: confirm.action, ...confirm.payload, password: actionPassword }),
        }),
      );
      setConfirm(null);
      setActionPassword("");
      await refresh();
    } catch {
      setError("管理操作失敗，房間狀態未更改。");
    }
  };
  const filterRecords = async (params: URLSearchParams) => {
    try {
      setRecords(
        await guarded(() =>
          requestJson(fetcher, `/api/admin/records?${params}`),
        ),
      );
    } catch {
      setError("未能載入篩選紀錄。");
    }
  };
  const exportXlsx = async () => {
    setExportStatus("正在準備 Excel……");
    try {
      const response = await fetcher(
        "/api/admin/export.xlsx?from=2026-01-01&to=2026-12-31",
        { credentials: "same-origin" },
      );
      if (response.status === 401) {
        onUnauthorized();
        return;
      }
      if (!response.ok) throw new Error();
      const blob = await response.blob(),
        url = URL.createObjectURL(blob),
        link = document.createElement("a");
      link.href = url;
      link.download = "STEAM-top.xlsx";
      link.click();
      URL.revokeObjectURL(url);
      setExportStatus("Excel 已下載。");
    } catch {
      setExportStatus("Excel 匯出失敗，請稍後重試。");
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
          <button onClick={exportXlsx}>匯出 Excel</button>
          <button className="danger-button" onClick={() => setDeleteOpen(true)}>
            刪除紀錄
          </button>
        </div>
      </header>
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
      <RecordsTable data={records} onFilter={filterRecords} />
      <AnalyticsCharts data={analytics} />
      {confirm ? (
        <div className="modal-scrim">
          <section
            className="panel confirm-dialog"
            role="dialog"
            aria-modal="true"
          >
            <h2>確認管理操作</h2>
            <p>確定要{confirm.label}？此操作會寫入稽核紀錄。</p>
            <label>再次輸入管理員密碼<input type="password" autoComplete="current-password" value={actionPassword} onChange={(event) => setActionPassword(event.target.value)} /></label>
            <button className="danger-button" onClick={runMutation} disabled={actionPassword.length < 8}>
              確認
            </button>
            <button onClick={() => { setActionPassword(""); setConfirm(null); }}>取消</button>
          </section>
        </div>
      ) : null}
      {deleteOpen ? (
        <DeleteDialog
          fetcher={fetcher}
          csrf={session.csrfToken}
          onDeleted={refresh}
          onClose={() => setDeleteOpen(false)}
        />
      ) : null}
    </main>
  );
}
