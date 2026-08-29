import type { LeaderboardResponse } from "./types";

export function LeaderboardTable({ data }: { data: LeaderboardResponse }) {
  return <section className="panel admin-section" aria-labelledby="leaderboard-title">
    <h2 id="leaderboard-title">學生總分排行榜（只供教師查看）</h2>
    <div className="table-scroll"><table><thead><tr><th>排名</th><th>學生</th><th>班別</th><th>對戰分</th><th>挑戰分</th><th>總分</th><th>場數</th></tr></thead>
      <tbody>{data.rows.map(row => <tr key={row.identityId}><td>{row.rank}</td><td>{row.displayName}</td><td>{row.className ?? "—"}</td><td>{row.battleScore}</td><td>{row.challengeScore}</td><td>{row.totalScore}</td><td>{row.matches}</td></tr>)}</tbody>
    </table></div>
    {!data.rows.length ? <p className="empty-state">目前篩選範圍沒有排行榜資料。</p> : null}
  </section>;
}
