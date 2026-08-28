import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RhythmLaunch } from "./RhythmLaunch";

describe("RhythmLaunch", () => {
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
