import { designSchema, type TopDesign } from "@steam-top/domain";
import { z } from "zod";

export const NOTEBOOK_KEY = "steam-top:learning:notebook:v1";
export const TUTORIAL_KEY = "steam-top:learning:tutorial:v1";
const resultSchema = z.object({ winner: z.enum(["player1", "player2", "draw"]), seconds: z.number().nonnegative(), contacts: z.number().nonnegative(), angularSpeed: z.number().finite(), modelVersion: z.string().max(100) });
const recordSchema = z.object({ id: z.string(), at: z.string(), version: z.string(), design: designSchema, prediction: z.string().max(500), observation: z.string().max(500), nextTest: z.string().max(500), result: resultSchema });
const schema = z.object({ version: z.literal(1), versions: z.array(z.object({ label: z.string(), saved: designSchema, draft: designSchema })).min(1).max(10), records: z.array(recordSchema).max(50) });
export type Notebook = z.infer<typeof schema>;
export type ExperimentRecord = z.infer<typeof recordSchema>;
export type ExperimentSummary = z.infer<typeof resultSchema>;
export const cloneDesign = (design: TopDesign): TopDesign => JSON.parse(JSON.stringify(design)) as TopDesign;
export function createNotebook(design: TopDesign): Notebook {
  return { version: 1, versions: [{ label: "A", saved: cloneDesign(design), draft: cloneDesign(design) }], records: [] };
}
export function copyVersion(book: Notebook, label: string): Notebook {
  const source = book.versions.find(v => v.label === label);
  if (!source || book.versions.length >= 10) return book;
  const nextLabel = "ABCDEFGHIJ"[book.versions.length]!;
  return { ...book, versions: [...book.versions, { label: nextLabel, saved: cloneDesign(source.draft), draft: cloneDesign(source.draft) }] };
}
export function loadNotebook(raw: string | null, fallback: TopDesign): { notebook: Notebook; writable: boolean } {
  if (raw === null) return { notebook: createNotebook(fallback), writable: true };
  try {
    if (raw.length > 2_000_000) throw new Error("NOTEBOOK_TOO_LARGE");
    return { notebook: schema.parse(JSON.parse(raw)), writable: true };
  } catch { return { notebook: createNotebook(fallback), writable: false }; }
}
export function designDifferences(a: TopDesign, b: TopDesign): string[] {
  const result: string[] = [];
  const add = (label: string, x: unknown, y: unknown) => { if (JSON.stringify(x) !== JSON.stringify(y)) result.push(`${label}：${typeof x === "object" ? "原輪廓" : String(x)} → ${typeof y === "object" ? "新輪廓" : String(y)}`); };
  a.layers.forEach((x, i) => {
    const y = b.layers[i]!;
    const label = ["頂層", "中層", "底層"][i];
    add(`${label}形狀`, x.shape, y.shape);
    add(`${label}直徑 (mm)`, x.diameterMm, y.diameterMm);
    if (x.shape !== "circle" && x.shape !== "custom" || y.shape !== "circle" && y.shape !== "custom") {
      add(`${label}角數`, x.points, y.points);
      add(`${label}圓角`, x.cornerRoundness, y.cornerRoundness);
    }
    add(`${label}旋轉角度`, x.rotationDeg, y.rotationDeg);
    if (x.shape === "custom" && y.shape === "custom") {
      const normalized = (layer: typeof x) => layer.outline?.vertices.map(p => [Number((p.x / layer.diameterMm).toFixed(6)), Number((p.y / layer.diameterMm).toFixed(6))]);
      add(`${label}輪廓`, normalized(x), normalized(y));
    }
  });
  for (const key of Object.keys(a.screwLayout) as (keyof TopDesign["screwLayout"])[]) add(`螺絲 ${key}`, a.screwLayout[key], b.screwLayout[key]);
  add("金屬碟直徑", a.metalDiscDiameterMm, b.metalDiscDiameterMm);
  return result;
}
export function notebookCsv(book: Notebook): string {
  const cell = (value: unknown) => {
    let text = String(value ?? "");
    if (/^[\s\uFEFF]*[=+@-]/.test(text)) text = `'${text}`;
    return `"${text.replaceAll('"', '""')}"`;
  };
  const rows: unknown[][] = [["日期時間 (ISO)", "版本", "預測", "觀察", "下次測試", "模型勝方", "模型秒數", "碰撞次數", "最後角速度", "模型版本", "固定條件", "設計 JSON"]];
  for (const r of book.records) rows.push([r.at, r.version, r.prediction, r.observation, r.nextTest, r.result.winner, r.result.seconds, r.result.contacts, r.result.angularSpeed, r.result.modelVersion, "seed=314159; launch=Great/Great; opponent=default", JSON.stringify(r.design)]);
  return `\uFEFF${rows.map(row => row.map(cell).join(",")).join("\r\n")}`;
}
