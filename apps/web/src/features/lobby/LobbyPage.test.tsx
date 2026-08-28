import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { LobbyPage } from "./LobbyPage";

describe("LobbyPage", () => {
  it("1000房間分頁初始DOM有界且最後房可達，沒有排行榜", async () => {
    const rooms = Array.from({ length: 1_000 }, (_, index) => ({ id: `room-${index + 1}`, code: `R${index + 1}`, name: `房間 ${index + 1}`, phase: "waiting" as const, player1: { displayName: null }, player2: { displayName: null }, spectatorCount: 0 }));
    render(<LobbyPage rooms={rooms} onCommand={vi.fn()} />);
    expect(screen.getAllByRole("article")).toHaveLength(50);
    for (let page = 1; page < 20; page += 1) await userEvent.click(screen.getByRole("button", { name: "下一頁" }));
    expect(screen.getByRole("heading", { name: "房間 1000" })).toBeVisible();
    expect(screen.queryByText("排行榜", { exact: false })).not.toBeInTheDocument();
  });
});
