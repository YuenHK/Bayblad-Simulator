import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { RealtimeClient, type RealtimeTransport } from "./realtime/socket-client";

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
});
