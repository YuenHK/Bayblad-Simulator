import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { makeDefaultDesign } from "@steam-top/domain";
import type { RoomSnapshotEvent } from "@steam-top/protocol";
import { describe, expect, it, vi } from "vitest";

import { RoomPage } from "./RoomPage";

const uuid = (digit: number) => `${digit}0000000-0000-4000-8000-000000000000`;
function room(role: "player1" | "player2" | "spectator", spectators = 1): RoomSnapshotEvent {
  const people = Array.from({ length: spectators }, (_, index) => ({ participantId: `s${index}`, displayName: `觀眾 ${index + 1}` }));
  if (role === "spectator" && !people.some((person) => person.participantId === "me")) {
    if (people.length > 0) people[0] = { participantId: "me", displayName: "我" };
    else people.push({ participantId: "me", displayName: "我" });
  }
  return {
    type: "room.snapshot", roomId: "room-1", code: "ABC123", name: "科學房",
    ownerParticipantId: "me", phase: "launch", revision: 1,
    player1: { participantId: role === "player1" ? "me" : "p1", displayName: "玩家一", ready: false, designId: null },
    player2: { participantId: role === "player2" ? "me" : "p2", displayName: "玩家二", ready: true, designId: uuid(2) },
    spectators: people, viewer: { participantId: "me", role, isOwner: true },
    protocolVersion: 1, serverEventId: uuid(1),
  };
}

const noop = vi.fn();
describe("RoomPage", () => {
  it("以VS競技結構呈現兩席並顯示準備鎖定狀態", () => {
    const snapshot = { ...room("spectator"), phase: "waiting" as const };
    const { container } = render(<RoomPage snapshot={snapshot} battle={{ phase: "waiting" }} design={makeDefaultDesign()} onCommand={noop} onLeave={noop} />);
    expect(container.querySelector(".versus-mark")).toHaveTextContent("VS");
    expect(container.querySelectorAll(".combatant-card")).toHaveLength(2);
    expect(container.querySelectorAll(".combatant-card.is-ready")).toHaveLength(1);
    expect(screen.getByText("已準備·設計已鎖定")).toBeVisible();
  });

  it("只有正在發射的玩家進入手機專注模式", () => {
    const { container, rerender } = render(<RoomPage snapshot={room("player1")} battle={{ phase: "launch" }} design={makeDefaultDesign()} onCommand={noop} onLeave={noop} />);
    expect(container.querySelector("main")).toHaveClass("battle-focus-content");
    rerender(<RoomPage snapshot={room("spectator")} battle={{ phase: "launch" }} design={makeDefaultDesign()} onCommand={noop} onLeave={noop} />);
    expect(container.querySelector("main")).not.toHaveClass("battle-focus-content");
  });

  it("玩家只顯示自己判定，DOM 不含對手 grade", () => {
    const { container } = render(<RoomPage snapshot={room("player1")} battle={{ phase: "launch", privateGrade: "Perfect" }} design={makeDefaultDesign()} onCommand={noop} onLeave={noop} />);
    expect(screen.getByText("你的判定：Perfect")).toBeVisible();
    expect(container.textContent).not.toContain("對手判定");
    expect(container.textContent).not.toContain("Great");
    expect(screen.getByText("PERFECT")).toBeVisible();
    expect(screen.getByText("完美")).toBeVisible();
  });

  it("觀眾者同時看到兩方判定", () => {
    render(<RoomPage snapshot={room("spectator")} battle={{ phase: "launch", spectatorGrades: { player1: "Perfect", player2: "Great" } }} design={makeDefaultDesign()} onCommand={noop} onLeave={noop} />);
    expect(screen.getByText("玩家一：Perfect")).toBeVisible();
    expect(screen.getByText("玩家二：Great")).toBeVisible();
    expect(screen.getByText("準確")).toBeVisible();
  });

  it("房主等待時可轉到觀賽，active match 時不可任意 move", async () => {
    const onCommand = vi.fn();
    const waiting = { ...room("player1"), phase: "waiting" as const };
    const { rerender } = render(<RoomPage snapshot={waiting} battle={{ phase: "waiting" }} design={makeDefaultDesign()} onCommand={onCommand} onLeave={noop} />);
    await userEvent.click(screen.getByRole("button", { name: "轉到觀賽區" }));
    expect(onCommand).toHaveBeenCalledWith(expect.objectContaining({ type: "room.move", target: "spectator" }));
    rerender(<RoomPage snapshot={room("player1")} battle={{ phase: "launch" }} design={makeDefaultDesign()} onCommand={onCommand} onLeave={noop} />);
    expect(screen.queryByRole("button", { name: "轉到觀賽區" })).not.toBeInTheDocument();
  });

  it("關房等待伺服器確認期間顯示 pending 並禁止重複命令", () => {
    render(<RoomPage snapshot={{ ...room("player1"), phase: "waiting" }} battle={{ phase: "waiting" }} design={makeDefaultDesign()} departurePending onCommand={noop} onLeave={noop} />);
    expect(screen.getByRole("button", { name: "正在關閉房間……" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "正在離房……" })).toBeDisabled();
  });

  it("離線或有未完成命令時禁止重複房間操作", () => {
    render(<RoomPage snapshot={{ ...room("player1"), phase: "waiting" }} battle={{ phase: "waiting" }} design={makeDefaultDesign()} actionsDisabled onCommand={noop} onLeave={noop} />);
    expect(screen.getByRole("button", { name: "離開房間" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "上載當前設計並準備" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "轉到觀賽區" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "關閉房間" })).toBeDisabled();
  });

  it("顯示兩席玩家、觀眾名稱與人數，500 人時以分頁讓最後一人可達", async () => {
    render(<RoomPage snapshot={room("spectator", 500)} battle={{ phase: "waiting" }} design={makeDefaultDesign()} onCommand={noop} onLeave={noop} />);
    expect(screen.getAllByText("玩家一").length).toBeGreaterThan(0);
    expect(screen.getAllByText("玩家二").length).toBeGreaterThan(0);
    expect(screen.getByRole("heading", { name: "500 位觀眾" })).toBeVisible();
    const list = screen.getByRole("list", { name: /觀眾玩家，共 500 人/ });
    expect(within(list).getAllByRole("listitem").length).toBeLessThanOrEqual(60);
    for (let page = 1; page < 10; page += 1) await userEvent.click(screen.getByRole("button", { name: "下一頁" }));
    expect(within(list).getByText("觀眾 500")).toBeVisible();
    expect(within(list).getAllByRole("listitem").length).toBeLessThanOrEqual(50);
  });

  it("節拍可以觸控或 Space 發射且只送一次", () => {
    const onCommand = vi.fn();
    render(<RoomPage snapshot={room("player1")} battle={{ phase: "launch", schedule: { roomId: "room-1", matchId: "match", roundId: "round", nonce: "nonce", serverTargetTimeMs: Date.now() + 1000, serverDeadlineTimeMs: Date.now() + 2500 } }} design={makeDefaultDesign()} onCommand={onCommand} onLeave={noop} />);
    const button = screen.getByRole("button", { name: "在判定線發射" });
    fireEvent.pointerDown(button, { pointerId: 1 });
    fireEvent.keyDown(window, { code: "Space" });
    expect(onCommand).toHaveBeenCalledTimes(1);
    expect(onCommand).toHaveBeenCalledWith(expect.objectContaining({ type: "launch.tap", nonce: "nonce" }));
  });

  it("等待、launch 與 battle 都不顯示總分", () => {
    for (const phase of ["waiting", "launch", "battle"] as const) {
      const { unmount } = render(<RoomPage snapshot={{ ...room("player1"), phase }} battle={{ phase }} design={makeDefaultDesign()} onCommand={noop} onLeave={noop} />);
      expect(screen.queryByText("總分", { exact: false })).not.toBeInTheDocument();
      expect(screen.queryByText("排行榜", { exact: false })).not.toBeInTheDocument();
      unmount();
    }
  });

  it("玩家二獲勝仍以勝方在前顯示 2:1", () => {
    const snapshot = { ...room("spectator"), phase: "result" as const };
    render(<RoomPage snapshot={snapshot} battle={{ phase: "result", matchFinished: {
      type: "match.finished", roomId: "room-1", matchId: "match",
      player1: { battlePoints: 1, challengePoints: 0, total: 1 },
      player2: { battlePoints: 2, challengePoints: .5, total: 2.5 },
      roundWinners: ["player2", "player1", "player2"], protocolVersion: 1, serverEventId: uuid(3),
    } }} design={makeDefaultDesign()} onCommand={noop} onLeave={noop} />);
    expect(screen.getByText("2:1")).toBeVisible();
    expect(screen.queryByText("1:2")).not.toBeInTheDocument();
  });
});
