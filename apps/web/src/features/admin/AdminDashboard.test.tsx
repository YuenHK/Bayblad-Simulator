import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { AdminApp } from "./AdminApp";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

it("keeps the password only in the form and redirects an expired session to login", async () => {
  const requests: Request[] = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(new URL(input.toString(), "http://localhost"), init); requests.push(request);
    if (request.url.endsWith("/api/admin/session")) return json({ error: "UNAUTHORIZED" }, 401);
    if (request.url.endsWith("/api/admin/login")) return new Response(null, { status: 204 });
    throw new Error(request.url);
  });
  render(<AdminApp fetcher={fetcher} />);
  await screen.findByRole("heading", { name: "教師登入" });
  await userEvent.clear(screen.getByLabelText("帳號"));
  await userEvent.type(screen.getByLabelText("帳號"), "admin");
  await userEvent.type(screen.getByLabelText("密碼"), "secret-password");
  await userEvent.click(screen.getByRole("button", { name: "登入" }));
  const login = requests.find((request) => request.url.endsWith("/api/admin/login"));
  expect(login?.url).not.toContain("secret-password");
  expect(localStorage.length).toBe(0);
  expect(await login?.json()).toEqual({ username: "admin", password: "secret-password" });
});

it("loads rooms, records and analytics after authentication without persisting PII", async () => {
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(input.toString(), "http://localhost");
    if (url.pathname === "/api/admin/session") return json({ username: "admin", expiresAt: "2026-08-30T00:00:00.000Z", csrfToken: "csrf" });
    if (url.pathname === "/api/admin/rooms") return json({ paused: false, rooms: [{ roomId: "r1", roomCode: "ABCD12", status: "waiting", players: [{ id: "p1", displayName: "1A 陳同學" }], spectators: [{ id: "s1", displayName: "觀眾" }] }] });
    if (url.pathname === "/api/admin/records") return json({ rows: [{ id: "m1", occurredAt: "2026-08-29T01:00:00Z", className: "1A", identity: "陳同學", deviceName: "iPad-01", parameters: "圓形 / 50 mm", totalScore: 2.5 }], total: 1, page: 1, pageSize: 25 });
    if (url.pathname === "/api/admin/analytics") return json({ usagePeriods: { daily: [{ period: "2026-08-29", activeDevices: 4, designs: 3, rooms: 2, matches: 1 }], weekly: [], monthly: [] }, parameterUsage: [{ dimension: "形狀", value: "圓形", count: 10, ratio: 0.5 }], rankings: { top: [{ label: "圓形 50mm", averageScore: 2.4, winRate: 0.6, sampleSize: 12 }], bottom: [], overallLaunchDistribution: {} }, refreshedAt: "2026-08-29T01:00:00Z" });
    throw new Error(url.pathname);
  });
  render(<AdminApp fetcher={fetcher} />);
  expect(await screen.findByRole("heading", { name: "教師控制台" })).toBeInTheDocument();
  expect(await screen.findByText("ABCD12")).toBeInTheDocument();
  expect(await screen.findByText("iPad-01")).toBeInTheDocument();
  expect(await screen.findByText("圓形 50mm")).toBeInTheDocument();
  await waitFor(() => expect(fetcher).toHaveBeenCalled());
  expect(localStorage.length).toBe(0);
});

it("requires explicit confirmation and password before destructive deletion", async () => {
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input.toString(), "http://localhost"); const method = init?.method ?? "GET";
    calls.push({ url: url.pathname, method, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    if (url.pathname === "/api/admin/session") return json({ username: "admin", expiresAt: "2026-08-30T00:00:00.000Z", csrfToken: "csrf" });
    if (url.pathname === "/api/admin/rooms") return json({ paused: false, rooms: [] });
    if (url.pathname === "/api/admin/records") return json({ rows: [], total: 0, page: 1, pageSize: 25 });
    if (url.pathname === "/api/admin/analytics") return json({ usagePeriods: { daily: [], weekly: [], monthly: [] }, parameterUsage: [], rankings: { top: [], bottom: [], overallLaunchDistribution: {} }, refreshedAt: "2026-08-29T01:00:00Z" });
    if (url.pathname.endsWith("deletion-preview")) return json({ previewToken: "x".repeat(43), filterHash: "a".repeat(64), expiresAt: "2026-08-30T00:00:00Z", counts: { identities: 2, designs: 4, matches: 3 } });
    if (url.pathname === "/api/admin/records" && method === "DELETE") return json({ auditId: "audit", counts: { identities: 2, designs: 4, matches: 3 } });
    throw new Error(`${method} ${url.pathname}`);
  });
  render(<AdminApp fetcher={fetcher} />);
  await screen.findByRole("heading", { name: "教師控制台" });
  await userEvent.click(screen.getByRole("button", { name: "刪除紀錄" }));
  await userEvent.click(screen.getByRole("button", { name: "預覽刪除範圍" }));
  expect(await screen.findByText(/2 個身份、4 個設計、3 場對戰/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "永久刪除" })).toBeDisabled();
  await userEvent.type(screen.getByLabelText("再次輸入管理員密碼"), "secret-password");
  await userEvent.type(screen.getByLabelText("輸入 DELETE 確認"), "DELETE");
  await userEvent.click(screen.getByRole("button", { name: "永久刪除" }));
  await waitFor(() => expect(calls.some((call) => call.method === "DELETE" && (call.body as { password?: string }).password === "secret-password")).toBe(true));
  expect(localStorage.length).toBe(0);
});
