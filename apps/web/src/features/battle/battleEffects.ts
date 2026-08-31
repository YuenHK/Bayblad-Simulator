import type { LaunchGrade } from "@steam-top/protocol";
import type { GameSound } from "../game/GameAudio";
import type { ArenaFrame } from "./BattleArena";

export type GradePresentation = Readonly<{ label: string; chinese: string; tone: GameSound; className: string }>;
const grades: Record<LaunchGrade, GradePresentation> = {
  Perfect: { label: "PERFECT", chinese: "完美", tone: "perfect", className: "grade-perfect" },
  Great: { label: "GREAT", chinese: "準確", tone: "great", className: "grade-great" },
  Good: { label: "GOOD", chinese: "偏差", tone: "good", className: "grade-good" },
  Miss: { label: "MISS", chinese: "失誤", tone: "miss", className: "grade-miss" },
};
export function gradePresentation(grade: LaunchGrade): GradePresentation { return grades[grade]; }

export type BattleEffect = Readonly<{ id: string; type: "impact" | "heavy-impact" | "rim"; x: number; y: number; intensity: number }>;
const distance = (a: Readonly<{ x: number; y: number }>, b: Readonly<{ x: number; y: number }>) => Math.hypot(a.x - b.x, a.y - b.y);

export function deriveBattleEffects(previous?: ArenaFrame, latest?: ArenaFrame): readonly BattleEffect[] {
  if (!previous || !latest || previous.sequence === latest.sequence) return [];
  const effects: BattleEffect[] = [];
  const priorDistance = distance(previous.player1, previous.player2);
  const currentDistance = distance(latest.player1, latest.player2);
  const closing = priorDistance - currentDistance;
  if (currentDistance <= 17 && priorDistance > 17) effects.push({ id: `impact-${latest.sequence}`, type: closing >= 14 ? "heavy-impact" : "impact", x: (latest.player1.x + latest.player2.x) / 2, y: (latest.player1.y + latest.player2.y) / 2, intensity: Math.min(1, Math.max(.35, closing / 24)) });
  for (const side of ["player1", "player2"] as const) {
    const radius = Math.hypot(latest[side].x, latest[side].y);
    const movement = distance(previous[side], latest[side]);
    if (radius >= 92 && movement >= 2) effects.push({ id: `rim-${side}-${latest.sequence}`, type: "rim", x: latest[side].x, y: latest[side].y, intensity: Math.min(1, movement / 10) });
  }
  return effects;
}
