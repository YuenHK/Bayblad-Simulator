import type { AdminHighScoringDesignsPage } from "@steam-top/protocol";
import { StaticDesignPreview } from "./StaticDesignPreview";
import { LayerRecord } from "./LayerRecord";

export function HighScoringDesigns({ data, onPage, error = "" }: { data: AdminHighScoringDesignsPage; onPage: (page: number) => void; error?: string }) {
  return <section className="panel admin-section" aria-labelledby="high-scoring-designs-title">
    <h2 id="high-scoring-designs-title">歷史紀錄中的高分設計</h2>
    <p>依篩選範圍內所有已完成對戰的平均分排序；歷史相關不代表最佳解或因果。樣本數為不重複對戰場數，平均分按參賽次數計算，同一設計可在同場出現兩次。</p>
    {error ? <p role="alert">{error}</p> : <>
    <div className="admin-design-grid">
      {data.rows.map(row => <article className="panel admin-design-card" key={`${row.designId}:${row.performanceModelVersion}:${row.physicsModelVersion}`}>
        <StaticDesignPreview design={row.design} /><div><p>{row.designId}</p><p>表現 {row.performanceModelVersion}／物理 {row.physicsModelVersion}</p></div>
        <p>平均分：<strong>{row.averageScore.toFixed(2)}</strong></p><p>{row.sampleSize} 場／{row.participantObservations} 次</p>
        <details><summary>三層設計及装配參數</summary><ul>{row.design.layers.map(layer => <li key={layer.position}><LayerRecord layer={layer} /></li>)}</ul>
          <p>總重量 {row.design.totalMassG} g；金屬片直徑 {row.design.metalDiscDiameterMm} mm；重心偏移 {row.design.centerOfMassOffsetMm} mm；轉動慣量 {row.design.momentOfInertiaGmm2} g·mm²
            {row.design.screwRadiusMm !== undefined && <>；螺絲孔半徑 {row.design.screwRadiusMm} mm</>}
            {row.design.screwRotationDeg !== undefined && <>；螺絲組旋轉 {row.design.screwRotationDeg}°</>}
          </p></details>
      </article>)}
    </div>
    {!data.rows.length ? <p className="empty-state">目前篩選範圍沒有高分設計資料。</p> : null}
    <div className="pagination"><button disabled={data.page <= 1} onClick={() => onPage(data.page - 1)}>上一頁</button><span>{data.total} 組設計及模型版本，第 {data.page}／{Math.max(1, Math.ceil(data.total / data.pageSize))} 頁</span><button disabled={data.page * data.pageSize >= data.total} onClick={() => onPage(data.page + 1)}>下一頁</button></div>
    </>}
  </section>;
}
