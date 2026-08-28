import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MatchResult } from "./MatchResult";

describe("MatchResult", () => {
  it("只在 match.finished 顯示 2:1、對戰分、挑戰分與總分", () => {
    render(<MatchResult result={{ winner: "player1", scoreline: "2:1", player1: { battlePoints: 2, challengePoints: .5, total: 2.5 }, player2: { battlePoints: 1, challengePoints: 0, total: 1 } }} />);
    expect(screen.getByText("2:1")).toBeVisible();
    expect(screen.getAllByText("對戰分", { exact: false })).toHaveLength(2);
    expect(screen.getAllByText("挑戰分", { exact: false })).toHaveLength(2);
    expect(screen.getAllByText("總分", { exact: false })).toHaveLength(2);
    expect(screen.queryByText("分析", { exact: false })).not.toBeInTheDocument();
  });

  it("取消對戰明示無分數", () => {
    render(<MatchResult cancelledReason="server-error" />);
    expect(screen.getByText("本場對戰已取消，不計分。")).toBeVisible();
    expect(screen.queryByText("總分", { exact: false })).not.toBeInTheDocument();
  });
});
