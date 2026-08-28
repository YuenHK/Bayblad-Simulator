import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RhythmLaunch } from "./RhythmLaunch";

describe("RhythmLaunch", () => {
  afterEach(() => vi.useRealTimers());
  it("schedule早於首個clock sample時只顯示同步並禁止tap", () => {
    const onCommand = vi.fn();
    render(<RhythmLaunch schedule={{ roomId: "room", matchId: "match", roundId: "round", nonce: "sync", serverTargetTimeMs: 3_000 }} onCommand={onCommand} clockReady={false} />);
    expect(screen.getByText("正在同步時間", { selector: ".launch-countdown" })).toBeVisible();
    expect(screen.getByRole("button", { name: "在判定線發射" })).toBeDisabled();
    expect(screen.queryByTestId("moving-marker")).not.toBeInTheDocument();
  });
  it("低動態模式不以 50ms 移動 marker，但仍可發射", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const onCommand = vi.fn();
    render(<RhythmLaunch schedule={{ roomId: "room", matchId: "match", roundId: "round", nonce: "nonce", serverTargetTimeMs: 3_000 }} onCommand={onCommand} reducedMotion />);
    expect(screen.getByTestId("rhythm-track")).toHaveClass("is-reduced-motion");
    expect(screen.queryByTestId("moving-marker")).not.toBeInTheDocument();
    vi.advanceTimersByTime(100);
    fireEvent.pointerDown(screen.getByRole("button", { name: "在判定線發射" }));
    expect(onCommand).toHaveBeenCalledOnce();
  });
  it("重連恢復同一 nonce 不重複發射，新一輪 nonce 可再發射", () => {
    const onCommand = vi.fn();
    const make = (nonce: string, roundId: string) => ({ roomId: "room", matchId: "match", roundId, nonce, serverTargetTimeMs: Date.now() });
    const { rerender } = render(<RhythmLaunch schedule={make("nonce-1", "round-1")} onCommand={onCommand} />);
    fireEvent.pointerDown(screen.getByRole("button", { name: "在判定線發射" }));
    rerender(<RhythmLaunch schedule={make("nonce-1", "round-1")} onCommand={onCommand} />);
    fireEvent.keyDown(window, { code: "Space" });
    expect(onCommand).toHaveBeenCalledTimes(1);
    rerender(<RhythmLaunch schedule={make("nonce-2", "round-2")} onCommand={onCommand} />);
    fireEvent.pointerDown(screen.getByRole("button", { name: "在判定線發射" }));
    expect(onCommand).toHaveBeenCalledTimes(2);
  });
});
