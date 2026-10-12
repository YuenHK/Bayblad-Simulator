import { designSchema, validateDesign, type TopDesign } from "@steam-top/domain";

type Candidate = Readonly<{ design: TopDesign; total: number; completedAtMs: number; matchId: string; slot: number }>;

/** In-memory mode: only authoritative completed human results may be recorded. */
export class HighestScoringDesign {
  #best?: Candidate;

  record(candidate: Candidate): void {
    if (!Number.isFinite(candidate.total) || !Number.isFinite(candidate.completedAtMs) || !designSchema.safeParse(candidate.design).success || !validateDesign(candidate.design).valid) return;
    const best = this.#best;
    if (best && !(candidate.total > best.total || (candidate.total === best.total && (
      candidate.completedAtMs > best.completedAtMs || (candidate.completedAtMs === best.completedAtMs && (
        candidate.matchId < best.matchId || (candidate.matchId === best.matchId && candidate.slot < best.slot)
      ))
    )))) return;
    this.#best = structuredClone(candidate);
  }

  design(): TopDesign | undefined {
    return this.#best ? structuredClone(this.#best.design) : undefined;
  }
}
