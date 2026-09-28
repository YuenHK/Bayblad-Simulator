import { StaticDesignPreview } from "./StaticDesignPreview";
import type { LeaderboardResponse } from "./types";

export function LeaderboardTable({ data,onPage,onViewHistory }: { data: LeaderboardResponse;onPage:(page:number)=>void;onViewHistory?:(identityId:string)=>void }) {
  return <section className="panel admin-section" aria-labelledby="leaderboard-title">
    <h2 id="leaderboard-title">學生總分排行榜</h2>
    <div className="table-scroll"><table><thead><tr><th>排名</th><th>學生</th><th>班別</th><th>對戰分</th><th>挑戰分</th><th>總分</th><th>場數</th><th>最高分場次設計</th></tr></thead>
      <tbody>{data.rows.map(row => <tr key={row.identityId}><td>{row.rank}</td><td>{row.displayName}</td><td>{row.className ?? "—"}</td><td>{row.battleScore}</td><td>{row.challengeScore}</td><td>{row.totalScore}</td><td>{row.matches}</td><td>{row.bestDesign ? <><StaticDesignPreview design={row.bestDesign.design} /><p>單場 {row.bestDesign.score} 分 · {new Date(row.bestDesign.occurredAt).toLocaleString("zh-HK")}</p></> : <p>尚無代表設計資料</p>}{onViewHistory && <button onClick={()=>onViewHistory(row.identityId)}>查看歷史設計</button>}</td></tr>)}</tbody>
    </table></div>
    {!data.rows.length ? <p className="empty-state">目前篩選範圍沒有排行榜資料。</p> : null}
    <div className="pagination"><button disabled={data.page<=1} onClick={()=>onPage(data.page-1)}>上一頁</button><span>{data.total} 位學生，第 {data.page}／{Math.max(1,Math.ceil(data.total/data.pageSize))} 頁</span><button disabled={data.page*data.pageSize>=data.total} onClick={()=>onPage(data.page+1)}>下一頁</button></div>
  </section>;
}
