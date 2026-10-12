import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { RealtimeClient, type RealtimeTransport } from "./realtime/socket-client";
import { createSafeStorage } from "./realtime/safe-storage";

class AppTransport implements RealtimeTransport {
  auth: Record<string, unknown> = {};
  connected = false;
  listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  connect() { this.connected = true; }
  disconnect() { this.connected = false; }
  emit() { return this; }
  on(event: string, listener: (...args: unknown[]) => void) { const listeners = this.listeners.get(event) ?? new Set(); listeners.add(listener); this.listeners.set(event, listeners); return this; }
  off(event: string, listener: (...args: unknown[]) => void) { this.listeners.get(event)?.delete(listener); return this; }
  fire(event: string, value?: unknown) { for (const listener of this.listeners.get(event) ?? []) listener(value); }
}

describe("App upload lifecycle", () => {
  afterEach(() => vi.useRealTimers());
  it("入房自動準備一次，完成後不自動再戰，轉到觀賽再坐下才再次準備", async () => {
    const transport = new AppTransport();
    const client = new RealtimeClient({ transport });
    const ready = vi.spyOn(client, "readyWithDesign").mockResolvedValue("20000000-0000-4000-8000-000000000000");
    render(<App client={client} />);
    const snapshot = { type: "room.snapshot", roomId: "room-1", code: "ABC123", name: "Room", ownerParticipantId: "p1", phase: "waiting", revision: 1,
      player1: { participantId: "p1", displayName: "玩家一", ready: false, designId: null }, player2: null, spectators: [],
      viewer: { participantId: "p1", role: "player1", isOwner: true }, protocolVersion: 1, serverEventId: "30000000-0000-4000-8000-000000000000" };
    await act(async () => {
      transport.fire("connect");
      transport.fire("server.event", { type: "protocol.welcome", selectedVersion: 1, sessionToken: "s".repeat(32), sessionStatus: "new", protocolVersion: 1, serverEventId: "10000000-0000-4000-8000-000000000000" });
      transport.fire("server.event", snapshot);
    });
    expect(ready).toHaveBeenCalledTimes(1);
    await act(async () => { transport.fire("server.event", { ...snapshot, phase: "battle", revision: 2, serverEventId: "40000000-0000-4000-8000-000000000000" }); });
    await act(async () => { transport.fire("server.event", { ...snapshot, revision: 3, serverEventId: "50000000-0000-4000-8000-000000000000" }); });
    expect(ready).toHaveBeenCalledTimes(1);
    await act(async () => { transport.fire("server.event", { ...snapshot, revision: 4, player1: null, spectators: [{ participantId: "p1", displayName: "玩家一" }], viewer: { ...snapshot.viewer, role: "spectator" }, serverEventId: "60000000-0000-4000-8000-000000000000" }); });
    expect(ready).toHaveBeenCalledTimes(1);
    await act(async () => { transport.fire("server.event", { ...snapshot, revision: 5, serverEventId: "70000000-0000-4000-8000-000000000000" }); });
    expect(ready).toHaveBeenCalledTimes(2);
  });
  it("places the teacher entry alongside project and ShapeCut links without embedding credentials", () => {
    render(<App client={new RealtimeClient({ transport: new AppTransport() })} />);
    const footer = within(screen.getByRole("contentinfo", { name: "專案與更多作品" }));
    expect(footer.getByText("專案與工具")).toBeVisible();
    expect(footer.getByRole("link", { name: "了解這個專案" })).toHaveAttribute("href", "https://github.com/YuenHK/Bayblad-Simulator#readme");
    expect(footer.getByRole("link", { name: "ShapeCut" })).toHaveAttribute("href", "https://yuenhk.github.io/ShapeCut/");
    expect(footer.getByText("我的另一個作品 · 雷射切割工具")).toBeVisible();
    const link = footer.getByRole("link", { name: "教師後台" });
    expect(link).toHaveAttribute("href", "https://bayblad-simulator-api.onrender.com/admin/");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });
  it("uses the site icon instead of the circular brand marker", () => {
    const client = new RealtimeClient({ transport: new AppTransport() });
    const { container } = render(<App client={client} />);
    const icon = container.querySelector('.app-brand img');
    expect(icon).toHaveAttribute('src', `${import.meta.env.BASE_URL}icons/favicon.svg`);
    expect(icon).toHaveAttribute('alt', '');
    expect(container.querySelector('.brand-core')).toBeNull();
    expect(container.querySelector('.brand-title')).toHaveTextContent('STEAM 陀螺');
    expect(screen.getAllByText("YUENHK")).toHaveLength(2);
    expect(screen.queryByText("ARENA LAB")).not.toBeInTheDocument();
  });
  it("response.json卡住逾時後會清除busy並顯示穩定訊息", async () => {
    vi.useFakeTimers();
    const transport = new AppTransport();
    const client = new RealtimeClient({ transport, fetcher: vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => new Promise(() => undefined) } as Response) });
    render(<App client={client} />);
    act(() => {
      transport.fire("connect");
      transport.fire("server.event", { type: "protocol.welcome", selectedVersion: 1, sessionToken: "s".repeat(32), sessionStatus: "new", protocolVersion: 1, serverEventId: "10000000-0000-4000-8000-000000000000" });
    });
    fireEvent.click(screen.getByRole("button", { name: "用此設計參戰" }));
    expect(screen.getByText("正在處理……")).toBeVisible();
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(screen.queryByText("正在處理……")).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("上載設計逾時，請重試。");
  });

  it("學生端提供音效及動態效果控制並保存選擇", () => {
    const values = new Map<string, string>();
    const storage = createSafeStorage({ getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) });
    const transport = new AppTransport();
    const client = new RealtimeClient({ transport });
    const { container } = render(<App client={client} storage={storage} />);
    expect(container.firstElementChild).toHaveClass("student-game");
    fireEvent.click(screen.getByRole("button", { name: "關閉音效" }));
    fireEvent.click(screen.getByRole("button", { name: "減少動態效果" }));
    expect(screen.getByRole("button", { name: "開啟音效" })).toBeVisible();
    expect(screen.getByRole("button", { name: "啟用完整動態效果" })).toBeVisible();
    expect([...values.values()].some((value) => value.includes('"soundEnabled":false') && value.includes('"motionEnabled":false'))).toBe(true);
  });
});
