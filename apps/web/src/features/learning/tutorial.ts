import { validateDesign, type TopDesign } from "@steam-top/domain";
import { designDifferences, type Notebook } from "./notebook";

export const TUTORIAL_STEPS = [
  { title: "修改一個造型", text: "在下方練習副本改頂層形狀或直徑，留意即時預覽與重量。正式設計不會改動。" },
  { title: "建立公平比較", text: "複製 A 為 B，選擇 B 並只改一個參數。其他條件相同，才容易比較差異。" },
  { title: "先預測，再測試", text: "為 A、B 各寫一句預測並執行固定條件測試。對手、發射力度與種子一樣。" },
  { title: "記下你的發現", text: "比較兩次結果，為每個紀錄寫觀察及下次想測甚麼。這裡不會替你提供最佳答案。" },
  { title: "體驗一場對戰", text: "建立下方教學房間，跟節拍發射，觀看完整 10 秒對戰，再返回房間。教學房間不公開、不計分。" },
  { title: "準備製作", text: "設計室的「下載 STL（供 3D打印）」只包含三層板材；「傳送至 ShapeCut（供 雷射切割）」可再轉 DXF。正式加工前要檢查尺寸、孔位、材料和試切。" },
] as const;
export function canAdvanceTutorial(step: number, book: Notebook, initial: TopDesign, battleReturned = false): boolean {
  if (step === 0) return validateDesign(book.versions[0]!.draft).valid && designDifferences(initial, book.versions[0]!.draft).some(s => /形狀|直徑/.test(s));
  if (step === 1) return book.versions.length >= 2 && book.versions.slice(0, 2).every(v => validateDesign(v.draft).valid) && designDifferences(book.versions[0]!.draft, book.versions[1]!.draft).length === 1;
  if (step === 2 || step === 3) return ["A", "B"].every(label => { const current = book.versions.find(v => v.label === label); return current && book.records.some(r => r.version === label && designDifferences(r.design, current.draft).length === 0 && r.prediction.trim() && (step === 2 || r.observation.trim() && r.nextTest.trim())); });
  if (step === 4) return battleReturned;
  return step === 5;
}
