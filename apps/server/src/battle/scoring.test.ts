import { describe, expect, it } from "vitest";

import {
  MASS_MEASUREMENT_PRECISION_G,
  challengePoints,
  scoreMatch,
} from "./scoring";

describe("challengePoints", () => {
  it("uses an explicit one-milligram measurement precision", () => {
    expect(MASS_MEASUREMENT_PRECISION_G).toBe(0.001);
  });

  it.each([
    [0, 0], [-4, 0], [6, 0.3], [9.999, 0.49995], [10, 0.5],
    [10.001, 0.5], [25, 0.5], [0.0004, 0], [0.0005, 0.00005],
    [0.1 + 0.2, 0.015],
  ])("maps a %sg weight advantage to %s points", (differenceG, expected) => {
    expect(challengePoints(differenceG)).toBe(expected);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "rejects a non-finite difference: %s",
    (differenceG) => expect(() => challengePoints(differenceG)).toThrow(),
  );
});

describe("scoreMatch", () => {
  it("scores the official 50g versus 40g 2:1 example", () => {
    const result = scoreMatch({
      player1MassG: 50,
      player2MassG: 40,
      roundWinners: ["player1", "player2", "player1"],
    });

    expect(result).toEqual({
      winner: "player1",
      player1: { battlePoints: 2, challengePoints: 0, total: 2 },
      player2: { battlePoints: 1, challengePoints: 0.5, total: 1.5 },
    });
  });

  it("scores a two-round sweep", () => {
    expect(scoreMatch({
      player1MassG: 45,
      player2MassG: 45,
      roundWinners: ["player1", "player1"],
    })).toEqual({
      winner: "player1",
      player1: { battlePoints: 2, challengePoints: 0, total: 2 },
      player2: { battlePoints: 0, challengePoints: 0, total: 0 },
    });
  });

  it("scores a player2 match win", () => {
    expect(scoreMatch({
      player1MassG: 40,
      player2MassG: 50,
      roundWinners: ["player2", "player1", "player2"],
    })).toEqual({
      winner: "player2",
      player1: { battlePoints: 1, challengePoints: 0.5, total: 1.5 },
      player2: { battlePoints: 2, challengePoints: 0, total: 2 },
    });
  });

  it("awards no challenge points at equal measured weight", () => {
    const result = scoreMatch({
      player1MassG: 40,
      player2MassG: 40.0004,
      roundWinners: ["player2", "player2"],
    });
    expect(result.player1.challengePoints).toBe(0);
    expect(result.player2.challengePoints).toBe(0);
  });

  it.each([
    [49, 40, 0.45],
    [49.999, 40, 0.49995],
    [50, 40, 0.5],
    [50.001, 40, 0.5],
    [60, 40, 0.5],
  ])("awards only the lighter player for %sg versus %sg", (
    player1MassG,
    player2MassG,
    expected,
  ) => {
    const result = scoreMatch({
      player1MassG,
      player2MassG,
      roundWinners: ["player1", "player1"],
    });
    expect(result.player1.challengePoints).toBe(0);
    expect(result.player2.challengePoints).toBe(expected);
    expect(result.player2.total).toBe(expected);
  });

  it("returns clean decimal totals instead of multiplication artefacts", () => {
    const result = scoreMatch({
      player1MassG: 46,
      player2MassG: 40,
      roundWinners: ["player1", "player1"],
    });
    expect(result.player2.challengePoints).toBe(0.3);
    expect(result.player2.total).toBe(0.3);
  });

  it.each([
    [Number.NaN, 40], [Number.POSITIVE_INFINITY, 40],
    [Number.NEGATIVE_INFINITY, 40], [0, 40], [-1, 40], [60.000_001, 40],
    [40, Number.NaN], [40, Number.POSITIVE_INFINITY],
    [40, Number.NEGATIVE_INFINITY], [40, 0], [40, -1], [40, 60.000_001],
  ])("rejects invalid match masses %s and %s", (player1MassG, player2MassG) => {
    expect(() => scoreMatch({
      player1MassG,
      player2MassG,
      roundWinners: ["player1", "player1"],
    })).toThrow();
  });

  it.each([
    { roundWinners: [] },
    { roundWinners: ["player1"] },
    { roundWinners: ["player1", "player2"] },
    { roundWinners: ["player1", "player1", "player1"] },
    { roundWinners: ["player2", "player2", "player1"] },
    { roundWinners: ["player1", "player2", "player1", "player2"] },
    { roundWinners: ["player1", "player1", "player2", "player2"] },
    { roundWinners: ["player1", "draw", "player1"] },
    { roundWinners: ["A", "B", "A"] },
  ])("rejects an unfinished or invalid sequence: $roundWinners", ({ roundWinners }) => {
    expect(() => scoreMatch({
      player1MassG: 50,
      player2MassG: 40,
      roundWinners,
    } as never)).toThrow();
  });

  it("strictly rejects extra input fields", () => {
    expect(() => scoreMatch({
      player1MassG: 50,
      player2MassG: 40,
      roundWinners: ["player1", "player1"],
      adminOverride: true,
    } as never)).toThrow();
  });

  it("calculates from one parsed canonical snapshot", () => {
    let player1Reads = 0;
    const input = {
      get player1MassG() {
        player1Reads += 1;
        return player1Reads === 1 ? 50 : 40;
      },
      player2MassG: 40,
      roundWinners: ["player1", "player2", "player1"] as (
        "player1" | "player2"
      )[],
    };

    const result = scoreMatch(input);

    expect(result.player2.challengePoints).toBe(0.5);
    expect(player1Reads).toBe(1);
  });

  it("returns a deeply immutable result", () => {
    const result = scoreMatch({
      player1MassG: 50,
      player2MassG: 40,
      roundWinners: ["player1", "player1"],
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.player1)).toBe(true);
    expect(Object.isFrozen(result.player2)).toBe(true);
    expect(() => {
      (result.player1 as { total: number }).total = 99;
    }).toThrow(TypeError);
    expect(result.player1.total).toBe(2);
  });
});
