import type { RecordsResponse } from "./types";
import { localizeAdminValue } from "./localize";
export type AdminFilters = {
  from: string;
  to: string;
  className: string;
  identity: string;
  device: string;
  parameter: string;
  page: number;
  pageSize: number;
};
export const filterParams = (filters: AdminFilters) => {
  const params = new URLSearchParams({
    from: filters.from,
    to: filters.to,
    page: String(filters.page),
    pageSize: String(filters.pageSize),
  });
  for (const key of ["className", "identity", "device", "parameter"] as const)
    if (filters[key]) params.set(key, filters[key]);
  return params;
};
const layerLabel = (
  layer: RecordsResponse["rows"][number]["design"]["layers"][number],
) =>
  `${localizeAdminValue(layer.position)}：${localizeAdminValue(layer.shape)} ${layer.points}角／${layer.diameterMm}mm／${layer.actualAreaMm2}mm²／${layer.holeCount}孔／旋轉${layer.rotationDeg}°／圓角${layer.cornerRoundness}`;
export function RecordsTable({
  data,
  filters,
  onFilters,
  selectedIdentities,
  onSelectIdentity,
}: {
  data: RecordsResponse;
  filters: AdminFilters;
  onFilters: (filters: AdminFilters) => void;
  selectedIdentities: ReadonlySet<string>;
  onSelectIdentity: (id: string, selected: boolean) => void;
}) {
  const patch = (key: keyof AdminFilters, value: string | number) =>
    onFilters({ ...filters, [key]: value, page: 1 });
  return (
    <section className="panel admin-section" aria-labelledby="records-title">
      <h2 id="records-title">對戰紀錄</h2>
      <form
        className="admin-filters"
        onSubmit={(event) => event.preventDefault()}
      >
        {Object.entries({
          className: "班別",
          identity: "身份／姓名",
          device: "裝置",
          parameter: "陀螺參數",
        }).map(([key, label]) => (
          <label key={key}>
            {label}
            <input
              type="search"
              value={String(filters[key as keyof AdminFilters])}
              onChange={(event) =>
                patch(key as keyof AdminFilters, event.target.value)
              }
            />
          </label>
        ))}
      </form>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>選取學生</th>
              <th>日期時間</th>
              <th>班別</th>
              <th>身份</th>
              <th>裝置</th>
              <th>完整參數</th>
              <th>總分</th>
            </tr>
          </thead>
          <tbody>
            {data.rows.map((row) => (
              <tr key={row.rowId}>
                <td>
                  {row.identityId ? (
                    <input
                      aria-label={`選取 ${row.identity}`}
                      type="checkbox"
                      checked={selectedIdentities.has(row.identityId)}
                      onChange={(event) =>
                        onSelectIdentity(row.identityId!, event.target.checked)
                      }
                    />
                  ) : (
                    "—"
                  )}
                </td>
                <td>{new Date(row.occurredAt).toLocaleString("zh-HK")}</td>
                <td>{row.className ?? "—"}</td>
                <td>{row.identity}</td>
                <td>{row.deviceName ?? "—"}</td>
                <td>
                  <details>
                    <summary>
                      {row.design.totalMassG}g；貼片{" "}
                      {row.design.metalDiscDiameterMm}mm
                    </summary>
                    <ul>
                      {row.design.layers.map((layer) => (
                        <li key={layer.position}>{layerLabel(layer)}</li>
                      ))}
                    </ul>
                    <p>
                      重心偏移 {row.design.centerOfMassOffsetMm}mm；轉動慣量{" "}
                      {row.design.momentOfInertiaGmm2} g·mm²
                    </p>
                  </details>
                </td>
                <td>{row.totalScore}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!data.rows.length ? <p className="empty-state">此頁沒有紀錄。</p> : null}
      <div className="pagination">
        <button
          disabled={filters.page <= 1}
          onClick={() => onFilters({ ...filters, page: filters.page - 1 })}
        >
          上一頁
        </button>
        <span>
          {data.total} 筆紀錄，第 {data.page}／
          {Math.max(1, Math.ceil(data.total / data.pageSize))} 頁
        </span>
        <button
          disabled={filters.page * filters.pageSize >= data.total}
          onClick={() => onFilters({ ...filters, page: filters.page + 1 })}
        >
          下一頁
        </button>
      </div>
    </section>
  );
}
