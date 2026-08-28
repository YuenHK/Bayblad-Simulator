import { validateMassLimit } from "@steam-top/domain";

export type MatchPlayer = "A" | "B";

export type ScoreMatchInput = Readonly<{
  massA: number;
  massB: number;
  roundWinners: readonly MatchPlayer[];
}>;

export type PlayerMatchScore = Readonly<{
  battlePoints: number;
  challengePoints: number;
  total: number;
}>;

export type MatchScoreResult = Readonly<{
  A: PlayerMatchScore;
  B: PlayerMatchScore;
}>;

const SCORE_DECIMAL_PLACES = 12;

function preciseScore(value: number): number {
  return Number(value.toFixed(SCORE_DECIMAL_PLACES));
}

export function challengePoints(differenceG: number): number {
  if (!Number.isFinite(differenceG)) {
    throw new TypeError("differenceG must be finite");
  }
  return preciseScore(Math.min(Math.max(differenceG, 0) * 0.05, 0.5));
}

function validateMass(value: unknown, field: "massA" | "massB"): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${field} must be finite`);
  }
  if (value <= 0) {
    throw new RangeError(`${field} must be positive`);
  }
  if (validateMassLimit(value).length > 0) {
    throw new RangeError(`${field} exceeds the course weight limit`);
  }
}

function validateRoundWinners(value: unknown): asserts value is readonly MatchPlayer[] {
  if (!Array.isArray(value) || (value.length !== 2 && value.length !== 3)) {
    throw new RangeError("roundWinners must contain a completed two- or three-round match");
  }

  let winsA = 0;
  let winsB = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (winsA === 2 || winsB === 2) {
      throw new RangeError("roundWinners contains a round after the match was complete");
    }

    const winner: unknown = value[index];
    if (winner === "A") {
      winsA += 1;
    } else if (winner === "B") {
      winsB += 1;
    } else {
      throw new TypeError("each round winner must be A or B");
    }
  }

  if (winsA !== 2 && winsB !== 2) {
    throw new RangeError("roundWinners does not describe a completed best-of-three match");
  }
}

export function scoreMatch(input: ScoreMatchInput): MatchScoreResult {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new TypeError("match input must be an object");
  }

  const candidate = input as Readonly<Record<string, unknown>>;
  validateMass(candidate.massA, "massA");
  validateMass(candidate.massB, "massB");
  validateRoundWinners(candidate.roundWinners);

  const battlePointsA = candidate.roundWinners.filter((winner) => winner === "A").length;
  const battlePointsB = candidate.roundWinners.length - battlePointsA;
  const weightDifferenceG = Math.abs(candidate.massA - candidate.massB);
  const lighterChallengePoints = challengePoints(weightDifferenceG);
  const challengePointsA = candidate.massA < candidate.massB ? lighterChallengePoints : 0;
  const challengePointsB = candidate.massB < candidate.massA ? lighterChallengePoints : 0;

  return {
    A: {
      battlePoints: battlePointsA,
      challengePoints: challengePointsA,
      total: preciseScore(battlePointsA + challengePointsA),
    },
    B: {
      battlePoints: battlePointsB,
      challengePoints: challengePointsB,
      total: preciseScore(battlePointsB + challengePointsB),
    },
  };
}
