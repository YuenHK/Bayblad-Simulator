import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { expect, it, vi } from "vitest";
import { AdminApp } from "./AdminApp";
import { AnalyticsCharts } from "./AnalyticsCharts";
import type { AnalyticsResponse } from "./types";
vi.mock("recharts", () => {
  const Container = ({ children }: { children?: ReactNode }) => children;
  const Empty = () => null;
  return {
    Bar: Empty,
    BarChart: Container,
    CartesianGrid: Empty,
    Legend: Empty,
    ResponsiveContainer: Container,
    Tooltip: Empty,
    XAxis: Empty,
    YAxis: Empty,
  };
});
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const record = {
  rowId: "m1:player1",
  matchId: "m1",
  slot: "player1",
  occurredAt: "2026-08-29T01:00:00.000Z",
  identityId: "550e8400-e29b-41d4-a716-446655440000",
  className: "1A",
  identity: "陳同學",
  deviceName: "iPad-01",
  design: {
    layers: ["top", "middle", "bottom"].map((position, index) => ({
      position,
      shape: "circle",
      points: 3,
      diameterMm: 50 - index,
      actualAreaMm2: 1000,
      holeCount: 2,
      rotationDeg: 0,
      cornerRoundness: 0,
    })),
    totalMassG: 25,
    metalDiscDiameterMm: 20,
    centerOfMassOffsetMm: 0,
    momentOfInertiaGmm2: 5000,
  },
  totalScore: 2.5,
};
const analytics: AnalyticsResponse = {
  filters: { from: "2026-08-01", to: "2026-08-29" },
  filterApplicability: {},
  usage: [],
  usagePeriods: {
    daily: [
      {
        date: "2026-08-29",
        activeDevices: 4,
        designs: 3,
        rooms: 2,
        completedMatches: 1,
        shapes: [],
      },
    ],
    weekly: [],
    monthly: [],
  },
  parameterUsage: [
    {
      scope: "allEligibleDesigns",
      dimension: "layerShape",
      value: { position: "top", shape: "circle" },
      count: 10,
      proportion: 0.5,
      performanceModelVersion: "1",
      totalGroups: 2,
      truncated: false,
      population: 20,
    },
  ],
  parameters: [],
  rankings: {
    top: [
      {
        dimension: "layerShape",
        value: { shape: "circle" },
        launchGrade: "Perfect",
        opponentStrengthBand: "low",
        performanceModelVersion: "1",
        physicsModelVersion: "2",
        totalGroups: 1,
        sampleSize: 12,
        participantObservations: 12,
        averageScore: 2.4,
        winRate: 0.6,
        opponentAverageStrength: 50,
        expectedWinRate: 0.5,
        outcomeResidual: 0.1,
        gradeOccurrenceCount: 12,
      },
    ],
    bottom: [],
    total: 1,
    hasMore: false,
    snapshotCursor: "cursor",
    overallLaunchDistribution: {
      Perfect: 1,
      Great: 2,
      Good: 3,
      Miss: 4,
      totalOccurrences: 10,
    },
  },
  refreshedAt: "2026-08-29T01:00:00.000Z",
};
it("labels historical performance with both model versions and sample size", () => {
  render(<AnalyticsCharts data={analytics} />);
  expect(screen.getByRole("heading", { name: /歷史最高平均表現/ })).toBeInTheDocument();
  expect(screen.getByText("表現 1／物理 2")).toBeInTheDocument();
  expect(screen.getByText("12")).toBeInTheDocument();
});

function authenticated(
  handler?: (url: URL, init?: RequestInit) => Promise<Response | undefined>,
) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input.toString(), "http://localhost");
    if (url.pathname === "/api/admin/session")
      return json({
        username: "admin",
        expiresAt: "2026-08-30T00:00:00.000Z",
        csrfToken: "csrf",
      });
    const handled = await handler?.(url, init);
    if (handled) return handled;
    if (url.pathname === "/api/admin/rooms")
      return json({ paused: false, rooms: [] });
    if (
      url.pathname === "/api/admin/records" &&
      (!init?.method || init.method === "GET")
    )
      return json({ rows: [record], total: 1, page: 1, pageSize: 25 });
    if (url.pathname === "/api/admin/analytics") return json(analytics);
    if (url.pathname === "/api/admin/leaderboard") return json({ rows: [], total: 0, page: 1, pageSize: 25 });
    if (url.pathname === "/api/admin/high-scoring-designs") return json({ rows: [{ designId: "550e8400-e29b-41d4-a716-446655440001", performanceModelVersion: "perf-1", physicsModelVersion: "physics-1", sampleSize: 3, participantObservations: 4, averageScore: 2.25, design: record.design }], total: 1, page: 1, pageSize: 25 });
    throw new Error(`${init?.method ?? "GET"} ${url.pathname}`);
  });
}
it("shows concrete historical designs with layers, sample count and model versions", async () => {
  render(<AdminApp fetcher={authenticated()} />);
  await userEvent.click(await screen.findByRole("tab", {name:"高分設計"}));
  expect(await screen.findByRole("heading", { name: "歷史紀錄中的高分設計" })).toBeInTheDocument();
  expect(await screen.findByText("表現 perf-1／物理 physics-1")).toBeInTheDocument();
  expect(screen.getByText(/不代表最佳解或因果/)).toBeInTheDocument();
  expect(screen.getByText("550e8400-e29b-41d4-a716-446655440001")).toBeInTheDocument();
});
it("ignores late design responses after filters change and paginates independently", async () => {
  let resolveOld: (response: Response) => void = () => undefined;
  const fetcher = authenticated(async url => {
    if (url.pathname !== "/api/admin/high-scoring-designs") return;
    if (!url.searchParams.get("className")) return new Promise<Response>(resolve => { resolveOld = resolve; });
    const page = Number(url.searchParams.get("page"));
    return json({ rows: [], total: 30, page, pageSize: 25 });
  });
  render(<AdminApp fetcher={fetcher} />);
  await userEvent.click(await screen.findByRole("tab", {name:"高分設計"}));
  const section = (await screen.findByRole("heading", { name: "歷史紀錄中的高分設計" })).closest("section")!;
  await userEvent.click(screen.getByText("篩選條件",{exact:true}));
  await userEvent.type(screen.getByLabelText("班別"), "1A");
  await waitFor(() => expect(within(section).getByText(/30 組設計及模型版本/)).toBeInTheDocument());
  await act(async () => resolveOld(json({ rows: [], total: 999, page: 1, pageSize: 25 })));
  expect(within(section).queryByText(/999 組/)).not.toBeInTheDocument();
  await userEvent.click(within(section).getByRole("button", { name: "下一頁" }));
  await waitFor(() => expect(within(section).getByText(/第 2／2 頁/)).toBeInTheDocument());
  expect(fetcher.mock.calls.some(([input]) => input.toString().includes("/api/admin/high-scoring-designs?") && input.toString().includes("page=2"))).toBe(true);
});
it("clears historical designs when their request loses authentication", async () => {
  const fetcher = authenticated(async url => {
    if (url.pathname === "/api/admin/high-scoring-designs" && url.searchParams.get("className")) return json({ error: "UNAUTHORIZED" }, 401);
  });
  render(<AdminApp fetcher={fetcher} />);
  await userEvent.click(await screen.findByRole("tab", {name:"高分設計"}));
  await screen.findByText("550e8400-e29b-41d4-a716-446655440001");
  await userEvent.click(screen.getByText("篩選條件",{exact:true}));
  await userEvent.type(screen.getByLabelText("班別"), "1");
  await screen.findByRole("heading", { name: "教師控制台" });
  expect(screen.queryByText("550e8400-e29b-41d4-a716-446655440001")).not.toBeInTheDocument();
});
it("keeps a fast high-scoring failure visible after the normal query debounce and clears it on retry", async () => {
  const fetcher = authenticated(async url => {
    if (url.pathname === "/api/admin/high-scoring-designs" && !url.searchParams.get("className")) return json({ error: "HIGH_SCORING_DESIGNS_UNAVAILABLE" }, 503);
  });
  render(<AdminApp fetcher={fetcher} />);
  await userEvent.click(await screen.findByRole("tab", {name:"高分設計"}));
  await waitFor(() => expect(fetcher.mock.calls.some(([url])=>String(url).includes("/api/admin/records?"))).toBe(true));
  const section = screen.getByRole("region", { name: "歷史紀錄中的高分設計" });
  expect(within(section).getByRole("alert")).toHaveTextContent("高分設計暫時無法載入。");
  expect(within(section).queryByText("目前篩選範圍沒有高分設計資料。")).not.toBeInTheDocument();
  await userEvent.click(screen.getByText("篩選條件",{exact:true}));
  await userEvent.type(screen.getByLabelText("班別"), "1A");
  await within(section).findByText("550e8400-e29b-41d4-a716-446655440001");
  expect(within(section).queryByRole("alert")).not.toBeInTheDocument();
});
it("keeps login password out of URL and storage", async () => {
  const requests: Request[] = [];
  const fetcher = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(
        new URL(input.toString(), "http://localhost"),
        init,
      );
      requests.push(request);
      if (request.url.endsWith("/session"))
        return json({ error: "UNAUTHORIZED" }, 401);
      if (request.url.endsWith("/login"))
        return new Response(null, { status: 204 });
      throw new Error(request.url);
    },
  );
  render(<AdminApp fetcher={fetcher} />);
  await screen.findByRole("heading", { name: "教師控制台" });
  await userEvent.type(screen.getByLabelText("口令"), "secret-password");
  await userEvent.click(screen.getByRole("button", { name: "進入控制台" }));
  const login = requests.find((request) => request.url.endsWith("/login"));
  expect(login?.url).not.toContain("secret-password");
  expect(localStorage.length).toBe(0);
});
it("runtime-validates authoritative analytics and records DTOs", async () => {
  const valid = authenticated();
  render(<AdminApp fetcher={valid} />);
  expect(
    await screen.findByRole("heading", { name: "教師控制台" }),
  ).toBeInTheDocument();
  await userEvent.click(await screen.findByRole("tab", {name:"對戰紀錄"}));
  expect(await screen.findByText("iPad-01")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("tab", {name:"總覽"}));
  expect((await screen.findAllByText(/形狀：圓形/)).length).toBeGreaterThan(0);
  expect(localStorage.length).toBe(0);
});
it("shows an error instead of rendering invalid legacy analytics", async () => {
  const fetcher = authenticated(async (url) =>
    url.pathname.endsWith("analytics")
      ? json({ usagePeriods: { daily: [{ period: "legacy", matches: 1 }] } })
      : undefined,
  );
  render(<AdminApp fetcher={fetcher} />);
  expect(await screen.findByRole("alert")).toHaveTextContent("格式不正確");
});
it("requires two confirmations for room operations and sends no password", async () => {
  const calls: unknown[] = [];
  const fetcher = authenticated(async (url, init) => {
    if (url.pathname === "/api/admin/rooms") return json({ paused: false, rooms: [{ roomId: "room-1", roomCode: "ABC123", name: "測試房", status: "waiting", players: [], spectators: [] }] });
    if (url.pathname === "/api/admin/rooms/actions" && init?.method === "POST") {
      calls.push(JSON.parse(String(init.body)));
      return json({ operationId: "550e8400-e29b-41d4-a716-446655440000", status: "completed" });
    }
    return undefined;
  });
  render(<AdminApp fetcher={fetcher} />);
  await screen.findByRole("heading", { name: "教師控制台" });
  await userEvent.click(await screen.findByRole("button", { name: "強制關房" }));
  expect(calls).toHaveLength(0);
  expect(screen.queryByLabelText("再次輸入管理員密碼")).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "繼續" }));
  expect(calls).toHaveLength(0);
  await userEvent.click(screen.getByRole("button", { name: "確定關閉房間 ABC123" }));
  await waitFor(() => expect(calls).toHaveLength(1));
  expect(calls[0]).toMatchObject({ action: "room.close", roomId: "room-1", confirmed: true });
  expect(calls[0]).not.toHaveProperty("password");
});
it("has no deletion or password-change controls in the shared dashboard", async () => {
  const fetcher = authenticated();
  render(<AdminApp fetcher={fetcher} />);
  await screen.findByRole("tab",{name:"總覽"});
  expect(screen.queryByRole("button",{name:"暫停平台"})).not.toBeInTheDocument();
  expect(screen.queryByRole("button",{name:"恢復平台"})).not.toBeInTheDocument();
  expect(screen.queryByRole("button",{name:"刪除紀錄"})).not.toBeInTheDocument();
  expect(screen.queryByRole("button",{name:"更改密碼"})).not.toBeInTheDocument();
  expect(fetcher.mock.calls.some(([,init])=>init?.method==="DELETE")).toBe(false);
});
