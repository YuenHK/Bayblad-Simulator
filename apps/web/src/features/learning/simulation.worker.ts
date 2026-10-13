import { designSchema } from "@steam-top/domain";
import { runLearningSimulation } from "./simulation";

self.onmessage = (event: MessageEvent) => {
  try {
    const design = designSchema.parse(event.data.design);
    const candidate = event.data.launch;
    const launch = candidate && ["Perfect", "Great", "Good", "Miss"].includes(candidate.grade) && Number.isFinite(candidate.angularMultiplier) && Number.isFinite(candidate.impulseMultiplier) && candidate.angularMultiplier >= .75 && candidate.angularMultiplier <= 1.1 && candidate.impulseMultiplier >= .75 && candidate.impulseMultiplier <= 1.1 ? candidate : undefined;
    self.postMessage({ ok: true, value: runLearningSimulation(design, launch) });
  } catch (error) { self.postMessage({ ok: false, error: error instanceof Error ? error.message : "實驗運算失敗" }); }
};
