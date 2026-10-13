import { makeDefaultDesign, validateDesign, type TopDesign } from "@steam-top/domain";
import { simulateMatchRound } from "../../../../server/src/battle/engine";
import type { LaunchJudgement } from "../../../../server/src/battle/launch";
import type { ExperimentSummary } from "./notebook";

export const FIXED_SEED = 314159;
export const FIXED_LAUNCH: LaunchJudgement = { grade: "Great", angularMultiplier: 1, impulseMultiplier: 1 };
export function runLearningSimulation(design: TopDesign, launch: LaunchJudgement = FIXED_LAUNCH) {
  if (!validateDesign(design).valid) throw new Error("設計尚未通過重量規格，請先修正。");
  const opponent = makeDefaultDesign();
  const battle = simulateMatchRound(design, opponent, { seed: FIXED_SEED, launchA: launch, launchB: FIXED_LAUNCH });
  const summary: ExperimentSummary = { winner: battle.outcome.winner, seconds: battle.ticks / 60, contacts: battle.finalStats.topTopBeginContactEpisodes, angularSpeed: battle.finalStats.player1.angularSpeed, modelVersion: battle.modelVersion };
  return { battle, opponent, summary };
}
export type LearningSimulation = ReturnType<typeof runLearningSimulation>;
