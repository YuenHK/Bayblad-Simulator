import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { AdminApp } from "./AdminApp";
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
const analytics = {
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
    if (url.pathname === "/api/admin/rooms")
      return json({ paused: false, rooms: [] });
    const handled = await handler?.(url, init);
    if (handled) return handled;
    if (
      url.pathname === "/api/admin/records" &&
      (!init?.method || init.method === "GET")
    )
      return json({ rows: [record], total: 1, page: 1, pageSize: 25 });
    if (url.pathname === "/api/admin/analytics") return json(analytics);
    throw new Error(`${init?.method ?? "GET"} ${url.pathname}`);
  });
}
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
  await screen.findByRole("heading", { name: "教師登入" });
  await userEvent.type(screen.getByLabelText("密碼"), "secret-password");
  await userEvent.click(screen.getByRole("button", { name: "登入" }));
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
  expect(await screen.findByText("iPad-01")).toBeInTheDocument();
  expect((await screen.findAllByText(/shape: circle/)).length).toBeGreaterThan(0);
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
it("previews exact deletion filter and clears password in finally", async () => {
  const calls: Array<{ method: string; body?: unknown }> = [];
  const fetcher = authenticated(async (url, init) => {
    const method = init?.method ?? "GET";
    calls.push({
      method,
      ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
    });
    if (url.pathname.endsWith("deletion-preview"))
      return json({
        previewToken: "x".repeat(43),
        filterHash: "a".repeat(64),
        expiresAt: "2026-08-30T00:00:00Z",
        counts: { identities: 2, designs: 4, matches: 3 },
      });
    if (url.pathname.endsWith("records") && method === "DELETE")
      return json({
        auditId: "audit",
        counts: { identities: 2, designs: 4, matches: 3 },
      });
    return undefined;
  });
  render(<AdminApp fetcher={fetcher} />);
  await screen.findByRole("heading", { name: "教師控制台" });
  await userEvent.click(screen.getByRole("button", { name: "刪除紀錄" }));
  await userEvent.click(screen.getByRole("button", { name: "預覽刪除範圍" }));
  expect(
    await screen.findByText(/2 個身份、4 個設計、3 場對戰/),
  ).toBeInTheDocument();
  await userEvent.type(
    screen.getByLabelText("再次輸入管理員密碼"),
    "secret-password",
  );
  await userEvent.type(screen.getByLabelText("輸入 DELETE 確認"), "DELETE");
  await userEvent.click(screen.getByRole("button", { name: "永久刪除" }));
  await waitFor(() =>
    expect(
      calls.some(
        (call) =>
          call.method === "DELETE" &&
          (call.body as { password?: string }).password === "secret-password",
      ),
    ).toBe(true),
  );
});
