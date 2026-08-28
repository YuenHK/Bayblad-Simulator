import { validateMassLimit } from "@steam-top/domain";
import {
  matchRoundWinnerSchema,
  type MatchRoundWinner,
  type MatchScore,
} from "@steam-top/protocol";
import { z } from "zod";

/**
 * Simulated masses have more precision than the student UI displays. Scoring
 * takes one deterministic measurement snapshot at 1 mg (0.001 g), then uses
 * integer milligrams so floating-point multiplication cannot alter boundaries.
 */
export const MASS_MEASUREMENT_PRECISION_G = 0.001;
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
  .strict()
  .transform(({ player1MassG, player2MassG, roundWinners }) => ({
    player1MassUnits: toMeasurementUnits(player1MassG),
    player2MassUnits: toMeasurementUnits(player2MassG),
    roundWinners,
  }));

export type ScoreMatchInput = z.input<typeof scoreMatchInputSchema>;
export type PlayerMatchScore = Readonly<MatchScore>;
export type MatchScoreResult = Readonly<{
  winner: MatchRoundWinner;
  player1: PlayerMatchScore;
  player2: PlayerMatchScore;
}>;

function toMeasurementUnits(massG: number): number {
  return Math.round((massG + Number.EPSILON) * MASS_UNITS_PER_GRAM);
}

function pointsFromDifferenceUnits(differenceUnits: number): number {
  return Math.min(differenceUnits, CHALLENGE_CAP_DIFFERENCE_UNITS) /
    CHALLENGE_DIVISOR;
}

export function challengePoints(differenceG: number): number {
  const parsedDifferenceG = z.number().finite().parse(differenceG);
  const boundedDifferenceG = Math.min(Math.max(parsedDifferenceG, 0), 10);
  return pointsFromDifferenceUnits(toMeasurementUnits(boundedDifferenceG));
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
  const differenceUnits = Math.abs(
    parsed.player1MassUnits - parsed.player2MassUnits,
  );
  const lighterChallengePoints = pointsFromDifferenceUnits(differenceUnits);
  const player1ChallengePoints = parsed.player1MassUnits < parsed.player2MassUnits
    ? lighterChallengePoints
    : 0;
  const player2ChallengePoints = parsed.player2MassUnits < parsed.player1MassUnits
    ? lighterChallengePoints
    : 0;

  return Object.freeze({
    winner: player1BattlePoints === 2 ? "player1" : "player2",
    player1: frozenScore(player1BattlePoints, player1ChallengePoints),
    player2: frozenScore(player2BattlePoints, player2ChallengePoints),
  });
}
