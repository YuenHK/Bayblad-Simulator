import { useCallback, useEffect, useRef, useState } from "react";
import {
  adminAnalyticsSummarySchema,
  adminRecordsPageSchema,
  adminLeaderboardPageSchema,
} from "@steam-top/protocol";
import { AdminModal } from "./AdminModal";
import { AdminApiError, jsonHeaders, requestJson } from "./api";
import { AnalyticsCharts } from "./AnalyticsCharts";
import { DeleteDialog } from "./DeleteDialog";
import { LeaderboardTable } from "./LeaderboardTable";
import { filterParams, RecordsTable, type AdminFilters } from "./RecordsTable";
import { RoomsPanel } from "./RoomsPanel";
import type {
  AdminSession,
  AnalyticsResponse,
  Fetcher,
  RecordsResponse,
  LeaderboardResponse,
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
    [leaderboard, setLeaderboard] = useState<LeaderboardResponse>({ rows: [], total: 0, page: 1, pageSize: 25 }),
    [analytics, setAnalytics] = useState<AnalyticsResponse | null>(null),
    [filters, setFilters] = useState(initialFilters),
    [leaderboardPage,setLeaderboardPage]=useState(1),
    [selected, setSelected] = useState<Set<string>>(new Set()),
    [error, setError] = useState(""),
    [confirm, setConfirm] = useState<{
      action: string;
      payload: object;
      label: string;
      operationId: string;
    } | null>(null),
    [password, setPassword] = useState(""),
    [mutationBusy, setMutationBusy] = useState(false),
    [deleteOpen, setDeleteOpen] = useState(false),
    [exportStatus, setExportStatus] = useState("");
  const exportController = useRef<AbortController | null>(null);
  const queryController = useRef<AbortController | null>(null);
  const queryGeneration = useRef(0);
  const guarded = useCallback(
    async <T,>(operation: () => Promise<T>) => {
      try {
        return await operation();
      } catch (reason) {
        if (reason instanceof AdminApiError && reason.status === 401) {
          queryController.current?.abort();
          setRecords(emptyRecords);
          setAnalytics(null);
          setRooms({ paused: false, rooms: [] });
          setSelected(new Set());
          onUnauthorized();
        }
        throw reason;
      }
    },
    [onUnauthorized],
  );
  const query = useCallback(
    async (next: AdminFilters) => {
      queryController.current?.abort();
      const controller = new AbortController(), generation = ++queryGeneration.current;
      queryController.current = controller;
      setError("");
      const params = filterParams(next),
        analyticsParams = new URLSearchParams({ from: next.from, to: next.to });
      if (next.className) analyticsParams.set("className", next.className);
      try {
        const [roomPage, recordPage, summary] = await Promise.all([
          guarded(() =>
            requestJson<RoomsResponse>(fetcher, "/api/admin/rooms", { signal: controller.signal }),
          ),
          guarded(() =>
            requestJson(
              fetcher,
              `/api/admin/records?${params}`,
              { signal: controller.signal },
              adminRecordsPageSchema,
            ),
          ),
          guarded(() =>
            requestJson(
              fetcher,
              `/api/admin/analytics?${analyticsParams}`,
              { signal: controller.signal },
              adminAnalyticsSummarySchema,
            ),
          ),
        ]);
        if (generation !== queryGeneration.current) return;
        setRooms(roomPage);
        setRecords(recordPage);
        setAnalytics(summary);
      } catch (reason) {
        if (generation !== queryGeneration.current || controller.signal.aborted) return;
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
    setRecords({ ...emptyRecords, pageSize: filters.pageSize });
    setAnalytics(null);
    setSelected(new Set());
    const timer = window.setTimeout(() => void query(filters), 250);
    return () => window.clearTimeout(timer);
  }, [filters, query]);
  useEffect(()=>setLeaderboardPage(1),[filters.from,filters.to,filters.className,filters.identity,filters.device,filters.parameter]);
  useEffect(() => {
    const controller = new AbortController();
    const params = filterParams({ ...filters, page: leaderboardPage });
    void guarded(() => requestJson(fetcher, `/api/admin/leaderboard?${params}`, { signal: controller.signal }, adminLeaderboardPageSchema))
      .then(setLeaderboard)
      .catch((reason) => { if (!controller.signal.aborted && !(reason instanceof AdminApiError && reason.status === 401)) setError("排行榜暫時無法載入。"); });
    return () => controller.abort();
  }, [fetcher, filters.from, filters.to, filters.className, filters.identity, filters.device, filters.parameter, filters.pageSize, guarded, leaderboardPage]);
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
  useEffect(() => () => { exportController.current?.abort(); queryController.current?.abort(); }, []);
  const mutate = (action: string, payload: object, label: string) => {
    if (!mutationBusy) setConfirm({ action, payload, label, operationId: crypto.randomUUID() });
  };
  const runMutation = async () => {
    if (!confirm || mutationBusy) return;
    setMutationBusy(true);
    try {
      const outcome=await guarded(() =>
        requestJson<{operationId:string;status:string}>(fetcher, "/api/admin/rooms/actions", {
          method: "POST",
          headers: jsonHeaders(session.csrfToken),
          body: JSON.stringify({
            action: confirm.action,
            ...confirm.payload,
            password,
            operationId: confirm.operationId,
          }),
        }),
      );
      let status=outcome.status;
      for(let attempt=0;status!=="completed"&&status!=="terminal_failed"&&attempt<20;attempt+=1){await new Promise(resolve=>window.setTimeout(resolve,250));const polled=await guarded(()=>requestJson<{status:string}>(fetcher,`/api/admin/rooms/actions/${confirm.operationId}`));status=polled.status;}
      if(status!=="completed")throw new Error(status==="terminal_failed"?"ADMIN_COMMAND_FAILED":"ADMIN_COMMAND_PENDING");
      await query(filters);
      setConfirm(null);
    } catch {
      try{const recovered=await guarded(()=>requestJson<{status:string}>(fetcher,`/api/admin/rooms/actions/${confirm.operationId}`));if(recovered.status==="completed"){await query(filters);setConfirm(null);return;}}catch{/* operation may not have reached server */}
      setError("管理操作仍在處理或暫時失敗；可使用同一確認視窗重試。");
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
      await guarded(() => requestJson(fetcher, "/api/admin/logout", {
        method: "POST",
        headers: jsonHeaders(session.csrfToken),
        body: "{}",
      }));
      setRecords(emptyRecords);
      setLeaderboard({ rows: [], total: 0, page: 1, pageSize: 25 });
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
      <LeaderboardTable data={leaderboard} onPage={setLeaderboardPage} />
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
          identities={records.rows.flatMap((row, index, rows) => row.identityId && selected.has(row.identityId) && rows.findIndex((candidate) => candidate.identityId === row.identityId) === index ? [{ id: row.identityId, displayName: row.identity, className: row.className, deviceName: row.deviceName }] : [])}
          onDeleted={async () => {
            setRecords(emptyRecords);
            setAnalytics(null);
            setSelected(new Set());
            await query(filters);
          }}
          onClose={() => setDeleteOpen(false)}
          onUnauthorized={onUnauthorized}
        />
      ) : null}
    </main>
  );
}
