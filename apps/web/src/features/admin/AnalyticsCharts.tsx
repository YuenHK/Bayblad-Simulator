import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type {
  AdminParameterPerformanceRow,
  AdminParameterUsageRow,
} from "@steam-top/protocol";
import type { AnalyticsResponse } from "./types";
import { localizeAdminKey, localizeAdminValue } from "./localize";

const names: Record<string, string> = {
  layerShape: "形狀",
  layerSides: "邊／角數",
  layerActualArea: "面積",
  holes: "螺絲孔",
  weight: "重量",
  layerOrder: "三層排序",
  metalDiscDiameter: "金屬貼片",
  totalMassGBucket: "重量",
  layerCombination: "三層組合",
  layerActualAreaBucket: "面積",
};
function valueLabel(value: Readonly<Record<string, unknown>>): string {
  return localizeAdminValue(value);
}
const performanceLabel = (row: AdminParameterPerformanceRow) =>
  `${names[row.dimension] ?? localizeAdminKey(row.dimension)}｜${valueLabel(row.value)}｜${localizeAdminValue(row.launchGrade)}｜對手 ${localizeAdminValue(row.opponentStrengthBand)}`;
function Performance({
  title,
  rows,
}: {
  title: string;
  rows: readonly AdminParameterPerformanceRow[];
}) {
  return (
    <section>
      <h3>{title}</h3>
      {rows.length ? (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>參數</th>
                <th>平均分</th>
                <th>勝率</th>
                <th>樣本</th>
              </tr>
            </thead>
            <tbody>
              {rows
                .filter((row) => row.sampleSize >= 10)
                .map((row, index) => (
                  <tr
                    key={`${row.dimension}-${JSON.stringify(row.value)}-${row.launchGrade}-${index}`}
                  >
                    <td>{performanceLabel(row)}</td>
                    <td>{row.averageScore.toFixed(2)}</td>
                    <td>{Math.round(row.winRate * 100)}%</td>
                    <td>{row.sampleSize}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p>尚未有足夠樣本。</p>
      )}
    </section>
  );
}
export function AnalyticsCharts({ data }: { data: AnalyticsResponse }) {
  const launch = Object.entries(data.rankings.overallLaunchDistribution)
    .filter(([key]) => key !== "totalOccurrences")
    .map(([grade, count]) => ({ grade: localizeAdminValue(grade), count }));
  return (
    <section className="panel admin-section" aria-labelledby="analytics-title">
      <h2 id="analytics-title">使用及參數統計</h2>
      <div className="chart-grid">
        {(["daily", "weekly", "monthly"] as const).map((period) => (
          <figure key={period}>
            <figcaption>
              {period === "daily"
                ? "每日"
                : period === "weekly"
                  ? "每週"
                  : "每月"}
              使用量
            </figcaption>
            <div className="chart-frame">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={data.usagePeriods[period]}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="date" />
                  <YAxis />
                  <Tooltip />
                  <Legend />
                  <Bar dataKey="activeDevices" name="使用裝置" fill="#2858a5" />
                  <Bar dataKey="designs" name="設計" fill="#8c6bb1" />
                  <Bar dataKey="rooms" name="房間" fill="#d58a25" />
                  <Bar
                    dataKey="completedMatches"
                    name="完成對戰"
                    fill="#43a875"
                  />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </figure>
        ))}
      </div>
      <h3>全部參數使用比例</h3>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>參數類別</th>
              <th>參數</th>
              <th>次數</th>
              <th>比例</th>
            </tr>
          </thead>
          <tbody>
            {data.parameterUsage.map((row: AdminParameterUsageRow, index) => (
              <tr
                key={`${row.dimension}-${JSON.stringify(row.value)}-${index}`}
              >
                <td>{names[row.dimension] ?? row.dimension}</td>
                <td>{valueLabel(row.value)}</td>
                <td>{row.count}</td>
                <td>{Math.round(row.proportion * 100)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Performance
        title="目前最高平均表現參數（樣本最少 10 場）"
        rows={data.rankings.top}
      />
      <Performance
        title="目前最低平均表現參數（樣本最少 10 場）"
        rows={data.rankings.bottom}
      />
      <h3>發射判定分佈</h3>
      <div className="chart-frame">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={launch}>
            <XAxis dataKey="grade" />
            <YAxis />
            <Tooltip />
            <Bar dataKey="count" name="出現次數" fill="#2858a5" />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </section>
  );
}
