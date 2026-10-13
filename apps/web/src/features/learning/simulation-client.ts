import type { TopDesign } from "@steam-top/domain";
import type { LaunchJudgement } from "../../../../server/src/battle/launch";
import type { LearningSimulation } from "./simulation";

/** No network or official match commands: this worker is entirely local practice. */
export function simulateInWorker(design: TopDesign, signal: AbortSignal, launch?: LaunchJudgement): Promise<LearningSimulation> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new DOMException("Aborted", "AbortError")); return; }
    const worker = new Worker(new URL("./simulation.worker.ts", import.meta.url), { type: "module" });
    const clean = () => { clearTimeout(timeout); signal.removeEventListener("abort", abort); worker.terminate(); };
    const abort = () => { clean(); reject(new DOMException("Aborted", "AbortError")); };
    const timeout = setTimeout(() => { clean(); reject(new Error("運算逾時，請重試或簡化輪廓。")); }, 30_000);
    signal.addEventListener("abort", abort, { once: true });
    worker.onerror = () => { clean(); reject(new Error("未能啟動背景運算，請重新載入後重試。")); };
    worker.onmessage = (event: MessageEvent<{ ok: boolean; value: LearningSimulation; error: string }>) => { clean(); if (event.data.ok) resolve(event.data.value); else reject(new Error(event.data.error)); };
    worker.postMessage({ design, launch });
  });
}
