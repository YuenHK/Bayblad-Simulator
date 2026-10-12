import { designSchema, validateDesign, type TopDesign } from "@steam-top/domain";

type Candidate = Readonly<{ design: TopDesign; total: number; completedAtMs: number; capturedAtMs?: number; matchId: string; slot: number; identityId: string; displayName: string }>;

/** In-memory mode: only authoritative completed human results may be recorded. */
export class HighestScoringDesign {
  readonly #students = new Map<string, { totalUnits: number; best: Candidate; label: string; labelAt: number }>();

  record(candidate: Candidate): void {
    if (!candidate.identityId || !Number.isFinite(candidate.total) || !Number.isFinite(candidate.completedAtMs) || !designSchema.safeParse(candidate.design).success || !validateDesign(candidate.design).valid) return;
    const student = this.#students.get(candidate.identityId);
    const best = student?.best;
    const replace = !best || candidate.total > best.total || (candidate.total === best.total && (
      candidate.completedAtMs > best.completedAtMs || (candidate.completedAtMs === best.completedAtMs && (
        candidate.matchId < best.matchId || (candidate.matchId === best.matchId && candidate.slot < best.slot)
      ))
    ));
    const capturedAtMs = candidate.capturedAtMs ?? candidate.completedAtMs;
    const latestLabel = !student || capturedAtMs > student.labelAt || (capturedAtMs === student.labelAt && candidate.displayName > student.label);
    this.#students.set(candidate.identityId, {
      totalUnits: (student?.totalUnits ?? 0) + Math.round(candidate.total * 1000),
      best: replace ? structuredClone(candidate) : best!,
      label: latestLabel ? candidate.displayName : student!.label,
      labelAt: latestLabel ? capturedAtMs : student!.labelAt,
    });
  }

  design(): TopDesign | undefined {
    const winner = [...this.#students.entries()].sort(([idA,a],[idB,b]) => b.totalUnits-a.totalUnits || a.label.localeCompare(b.label) || idA.localeCompare(idB))[0]?.[1];
    return winner ? structuredClone(winner.best.design) : undefined;
  }
}
