import { describe, expect, it } from "vitest";

import { challengePoints, scoreMatch } from "./scoring";

describe("challengePoints", () => {
  it.each([
    [0, 0],
    [-4, 0],
    [6, 0.3],
    [9.99, 0.4995],
    [10, 0.5],
    [25, 0.5],
  ])("maps a %sg weight advantage to %s points", (differenceG, expected) => {
    expect(challengePoints(differenceG)).toBe(expected);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "rejects a non-finite difference: %s",
    (differenceG) => {
      expect(() => challengePoints(differenceG)).toThrow(TypeError);
    },
  );
});

describe("scoreMatch", () => {
  it("scores the official 50g versus 40g 2:1 example", () => {
    const result = scoreMatch({
      massA: 50,
      massB: 40,
      roundWinners: ["A", "B", "A"],
    });

    expect(result.A).toEqual({
      battlePoints: 2,
      challengePoints: 0,
      total: 2,
    });
    expect(result.B).toEqual({
      battlePoints: 1,
      challengePoints: 0.5,
      total: 1.5,
    });
  });

  it("scores a two-round sweep", () => {
    expect(scoreMatch({ massA: 45, massB: 45, roundWinners: ["A", "A"] }))
      .toEqual({
        A: { battlePoints: 2, challengePoints: 0, total: 2 },
        B: { battlePoints: 0, challengePoints: 0, total: 0 },
      });
  });

  it("scores a player B match win", () => {
    expect(scoreMatch({ massA: 40, massB: 50, roundWinners: ["B", "A", "B"] }))
      .toEqual({
        A: { battlePoints: 1, challengePoints: 0.5, total: 1.5 },
        B: { battlePoints: 2, challengePoints: 0, total: 2 },
      });
  });

  it("awards no challenge points at equal weight", () => {
    const result = scoreMatch({ massA: 40, massB: 40, roundWinners: ["B", "B"] });

    expect(result.A.challengePoints).toBe(0);
    expect(result.B.challengePoints).toBe(0);
  });

  it.each([
    [49, 40, 0.45],
    [50, 40, 0.5],
    [60, 40, 0.5],
  ])(
    "awards the lighter player the bounded challenge score for %sg versus %sg",
    (massA, massB, expected) => {
      const result = scoreMatch({ massA, massB, roundWinners: ["A", "A"] });

      expect(result.A.challengePoints).toBe(0);
      expect(result.B.challengePoints).toBe(expected);
      expect(result.B.total).toBe(expected);
    },
  );

  it("returns clean decimal totals instead of binary floating-point artefacts", () => {
    const result = scoreMatch({ massA: 46, massB: 40, roundWinners: ["A", "A"] });

    expect(result.B.challengePoints).toBe(0.3);
    expect(result.B.total).toBe(0.3);
  });

  it.each([
    [Number.NaN, 40],
    [Number.POSITIVE_INFINITY, 40],
    [Number.NEGATIVE_INFINITY, 40],
    [0, 40],
    [-1, 40],
    [60.000_001, 40],
    [40, Number.NaN],
    [40, Number.POSITIVE_INFINITY],
    [40, Number.NEGATIVE_INFINITY],
    [40, 0],
    [40, -1],
    [40, 60.000_001],
  ])("rejects invalid match masses %s and %s", (massA, massB) => {
    expect(() => scoreMatch({ massA, massB, roundWinners: ["A", "A"] }))
      .toThrow();
  });

  it.each([
    { roundWinners: [] },
    { roundWinners: ["A"] },
    { roundWinners: ["A", "B"] },
    { roundWinners: ["A", "A", "A"] },
    { roundWinners: ["B", "B", "A"] },
    { roundWinners: ["A", "B", "A", "B"] },
    { roundWinners: ["A", "A", "B", "B"] },
    { roundWinners: ["A", "draw", "A"] },
  ])("rejects an unfinished or overlong sequence: $roundWinners", ({ roundWinners }) => {
    expect(() => scoreMatch({
      massA: 50,
      massB: 40,
      roundWinners,
    } as never)).toThrow();
  });

  it("does not mutate the caller's input", () => {
    const input = Object.freeze({
      massA: 50,
      massB: 40,
      roundWinners: Object.freeze(["A", "B", "A"] as const),
    });

    scoreMatch(input);

    expect(input.roundWinners).toEqual(["A", "B", "A"]);
  });
});
