import { MAX_MASS_G, validateMassLimit } from "@steam-top/domain";
import {
  matchRoundWinnerSchema,
  type MatchRoundWinner,
  type MatchScore,
} from "@steam-top/protocol";
import { z } from "zod";

/**
 * Simulated masses have more precision than the student UI displays. Scoring
 * quantises the weight difference once at 1 mg (0.001 g), then uses integer
 * milligrams so floating-point multiplication cannot alter boundaries.
 */
export const MASS_MEASUREMENT_PRECISION_G = 0.001;
// At the 60 g domain maximum, Number.EPSILON * mass exceeds one binary64 ULP.
// Two such bounds cover both represented operands and their subtraction. The
// result is still over ten million times smaller than the 1 mg scoring unit.
const MASS_DIFFERENCE_TOLERANCE_SAFETY_FACTOR = 2;
export const MASS_DIFFERENCE_FLOAT_TOLERANCE_G =
  Number.EPSILON * MAX_MASS_G * MASS_DIFFERENCE_TOLERANCE_SAFETY_FACTOR;
const MASS_UNITS_PER_GRAM = 1 / MASS_MEASUREMENT_PRECISION_G;
const CHALLENGE_CAP_DIFFERENCE_UNITS = 10 * MASS_UNITS_PER_GRAM;
const CHALLENGE_DIVISOR = 20 * MASS_UNITS_PER_GRAM;

const measuredMassSchema = z
  .number()
  .finite()
  .positive()
  .superRefine((massG, context) => {
    if (validateMassLimit(massG).length > 0) {
      context.addIssue({
        code: "custom",
        message: "Mass exceeds the course weight limit",
      });
    }
  });

const completedRoundWinnersSchema = z
  .array(matchRoundWinnerSchema)
  .min(2)
  .max(3)
  .superRefine((roundWinners, context) => {
    let player1Wins = 0;
    let player2Wins = 0;

    for (let index = 0; index < roundWinners.length; index += 1) {
      if (player1Wins === 2 || player2Wins === 2) {
        context.addIssue({
          code: "custom",
          message: "A round cannot be recorded after the match is complete",
          path: [index],
        });
        return;
      }
      if (roundWinners[index] === "player1") {
        player1Wins += 1;
      } else {
        player2Wins += 1;
      }
    }

    if (player1Wins !== 2 && player2Wins !== 2) {
      context.addIssue({
        code: "custom",
        message: "Round winners must describe a completed best-of-three match",
      });
    }
  });

const scoreMatchInputSchema = z
  .object({
    player1MassG: measuredMassSchema,
    player2MassG: measuredMassSchema,
    roundWinners: completedRoundWinnersSchema,
  })
  .strict();

export type ScoreMatchInput = z.input<typeof scoreMatchInputSchema>;
export type PlayerMatchScore = Readonly<MatchScore>;
export type MatchScoreResult = Readonly<{
  winner: MatchRoundWinner;
  player1: PlayerMatchScore;
  player2: PlayerMatchScore;
}>;

function toDifferenceUnits(differenceG: number): number {
  return Math.round(
    (differenceG + MASS_DIFFERENCE_FLOAT_TOLERANCE_G) * MASS_UNITS_PER_GRAM,
  );
}

function pointsFromDifferenceUnits(differenceUnits: number): number {
  return Math.min(differenceUnits, CHALLENGE_CAP_DIFFERENCE_UNITS) /
    CHALLENGE_DIVISOR;
}

export function challengePoints(differenceG: number): number {
  const parsedDifferenceG = z.number().finite().parse(differenceG);
  const boundedDifferenceG = Math.min(Math.max(parsedDifferenceG, 0), 10);
  return pointsFromDifferenceUnits(toDifferenceUnits(boundedDifferenceG));
}

function frozenScore(
  battlePoints: number,
  challengePointsValue: number,
): PlayerMatchScore {
  return Object.freeze({
    battlePoints,
    challengePoints: challengePointsValue,
    total: battlePoints + challengePointsValue,
  });
}

export function scoreMatch(input: ScoreMatchInput): MatchScoreResult {
  const parsed = scoreMatchInputSchema.parse(input);
  const player1BattlePoints = parsed.roundWinners.filter(
    (winner) => winner === "player1",
  ).length;
  const player2BattlePoints = parsed.roundWinners.length - player1BattlePoints;
  const lighterChallengePoints = challengePoints(
    Math.abs(parsed.player1MassG - parsed.player2MassG),
  );
  const player1ChallengePoints = parsed.player1MassG < parsed.player2MassG
    ? lighterChallengePoints
    : 0;
  const player2ChallengePoints = parsed.player2MassG < parsed.player1MassG
    ? lighterChallengePoints
    : 0;

  return Object.freeze({
    winner: player1BattlePoints === 2 ? "player1" : "player2",
    player1: frozenScore(player1BattlePoints, player1ChallengePoints),
    player2: frozenScore(player2BattlePoints, player2ChallengePoints),
  });
}
