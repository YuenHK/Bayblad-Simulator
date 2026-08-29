const labels: Readonly<Record<string, string>> = {
  top: "上層", middle: "中層", bottom: "下層",
  circle: "圓形", polygon: "多邊形", star: "星形", wave: "波浪形",
  layerShape: "形狀", layerSides: "邊／角數", layerActualArea: "面積",
  holes: "螺絲孔", weight: "重量", layerOrder: "三層排序",
  metalDiscDiameter: "金屬貼片直徑", totalMassGBucket: "總重量",
  layerCombination: "三層組合", layerActualAreaBucket: "面積範圍",
  position: "位置", shape: "形狀", points: "邊／角數", diameterMm: "直徑（毫米）",
  Perfect: "完美", Great: "很好", Good: "良好", Miss: "失誤",
  low: "較弱", medium: "相若", high: "較強", Other: "其他",
};

export const localizeAdminValue = (value: unknown): string => {
  if (value === null) return "不適用";
  if (Array.isArray(value)) return value.map(localizeAdminValue).join("、");
  if (typeof value === "object") return Object.entries(value as Record<string, unknown>)
    .map(([key, item]) => `${labels[key] ?? key}：${localizeAdminValue(item)}`).join("、");
  return labels[String(value)] ?? String(value);
};

export const localizeAdminKey = (value: string): string => labels[value] ?? value;
