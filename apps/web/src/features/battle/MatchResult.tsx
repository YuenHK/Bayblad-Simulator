type Score = Readonly<{ battlePoints: number; challengePoints: number; total: number }>;
export type MatchResultView = Readonly<{ winner: "player1" | "player2"; scoreline: "2:0" | "2:1"; player1: Score; player2: Score }>;
export function MatchResult({ result, cancelledReason }: Readonly<{ result?: MatchResultView | undefined; cancelledReason?: "attempt-limit" | "server-error" | undefined }>) {
  if (cancelledReason) return <section className="result-card cancelled" role="status"><h3>對戰已取消</h3><p>本場對戰已取消，不計分。</p></section>;
  if (!result) return null;
  return <section className="result-card" aria-labelledby="result-heading"><h3 id="result-heading">對戰結果</h3><strong className="scoreline">{result.scoreline}</strong><p>{result.winner === "player1" ? "玩家一" : "玩家二"}獲勝</p><div className="score-grid">{([result.player1, result.player2] as const).map((score, index) => <dl key={index}><dt>玩家{index === 0 ? "一" : "二"}</dt><dd>對戰分：{score.battlePoints}</dd><dd>挑戰分：{score.challengePoints.toFixed(1)}</dd><dd>總分：{score.total.toFixed(1)}</dd></dl>)}</div></section>;
}
