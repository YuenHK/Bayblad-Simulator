import { makeDefaultDesign, validateDesign, type TopDesign } from "@steam-top/domain";
import { useEffect, useRef, useState } from "react";
import { DesignerPage } from "../designer/DesignerPage";
import { TopViewSvg } from "../designer/TopViewSvg";
import type { GameAudio } from "../game/GameAudio";
import { cloneDesign, copyVersion, createNotebook, designDifferences, loadNotebook, notebookCsv, NOTEBOOK_KEY, TUTORIAL_KEY, type Notebook } from "./notebook";
import { simulateInWorker } from "./simulation-client";
import { PracticeBattle } from "./PracticeBattle";
import { canAdvanceTutorial, TUTORIAL_STEPS } from "./tutorial";
import "./learning.css";

function readLocal(): string | null { try { return localStorage.getItem(NOTEBOOK_KEY); } catch { return null; } }
function markTutorial(value: "completed" | "skipped") { try { localStorage.setItem(TUTORIAL_KEY, value); } catch { /* Practice still works without storage. */ } }

export function LearningPage({ initialDesign, startTutorial = false, reducedMotion, gameAudio, onAdopt }: { initialDesign: TopDesign; startTutorial?: boolean; reducedMotion: boolean; gameAudio: GameAudio; onAdopt: (design: TopDesign) => void }) {
  const [loaded] = useState(() => loadNotebook(readLocal(), initialDesign));
  const [normal, setNormal] = useState(loaded.notebook);
  const [tutorialInitial, setTutorialInitial] = useState(() => makeDefaultDesign());
  const [practice, setPractice] = useState(() => createNotebook(tutorialInitial));
  const [tutorial, setTutorial] = useState(startTutorial);
  const [step, setStep] = useState(0);
  const [selected, setSelected] = useState("A");
  const [compare, setCompare] = useState("A");
  const [revision, setRevision] = useState(0);
  const [prediction, setPrediction] = useState("");
  const [busy, setBusy] = useState(false);
  const [editorValid, setEditorValid] = useState(true);
  const [error, setError] = useState("");
  const [storageWarning, setStorageWarning] = useState(loaded.writable ? "" : "舊紀錄未能讀取，已保留原資料；本次只在記憶體使用，請匯出紀錄。");
  const [battleReturned, setBattleReturned] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const book = tutorial ? practice : normal;
  const version = book.versions.find(v => v.label === selected) ?? book.versions[0]!;
  const other = book.versions.find(v => v.label === compare) ?? book.versions[0]!;
  const differences = designDifferences(other.draft, version.draft);
  const update = (fn: (previous: Notebook) => Notebook) => (tutorial ? setPractice : setNormal)(fn);
  useEffect(() => {
    if (!loaded.writable) return;
    try { const raw = JSON.stringify(normal); if (raw.length > 2_000_000) throw new Error("too large"); localStorage.setItem(NOTEBOOK_KEY, raw); }
    catch { setStorageWarning("無法儲存在這個瀏覽器，請在離開前匯出 CSV。無痕視窗關閉後資料不會保留。"); }
  }, [normal, loaded.writable]);
  useEffect(() => () => controller.current?.abort(), []);
  const changeMode = (next: boolean) => {
    controller.current?.abort(); setBusy(false); setError(""); setSelected("A"); setCompare("A"); setPrediction(""); setRevision(r => r + 1);
    if (next) { const design = makeDefaultDesign(); setTutorialInitial(design); setPractice(createNotebook(design)); setStep(0); setBattleReturned(false); }
    setTutorial(next);
  };
  const test = async () => {
    if (busy || book.records.length >= 50 || !editorValid || !prediction.trim() || !validateDesign(version.draft).valid) return;
    const abort = new AbortController(); controller.current = abort; setBusy(true); setError("");
    const snapshot = cloneDesign(version.draft);
    const label = version.label;
    const predicted = prediction.trim();
    try {
      const result = await simulateInWorker(snapshot, abort.signal);
      if (abort.signal.aborted) return;
      update(previous => previous.records.length >= 50 ? previous : ({ ...previous, records: [...previous.records, { id: crypto.randomUUID(), at: new Date().toISOString(), version: label, design: snapshot, prediction: predicted, observation: "", nextTest: "", result: result.summary }] }));
      setPrediction("");
    } catch (failure) { if (!abort.signal.aborted) setError(failure instanceof Error ? failure.message : "測試失敗，請重試。"); }
    finally { if (controller.current === abort) setBusy(false); }
  };
  const exportCsv = () => {
    const url = URL.createObjectURL(new Blob([notebookCsv(book)], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a"); link.href = url; link.download = `陀螺實驗紀錄-${new Date().toISOString().slice(0, 10)}.csv`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return <main className="learning-workspace">
    <section className="panel learning-heading">
      <h1>{tutorial ? "操作教學" : "實驗室"}</h1>
      <p>先預測、只改一個變項、記下發現。這裡的練習不計正式分數，也不影響電腦玩家設計。</p>
      {!tutorial ? <button onClick={() => changeMode(true)}>重開操作教學</button> : <button onClick={() => { markTutorial("skipped"); changeMode(false); }}>跳過教學</button>}
      {tutorial ? <div role="status"><p>步驟 {step + 1}／{TUTORIAL_STEPS.length}：{TUTORIAL_STEPS[step]!.title}</p><p>{TUTORIAL_STEPS[step]!.text}</p><button disabled={!canAdvanceTutorial(step, book, tutorialInitial, battleReturned) || busy || step < 4 && !editorValid} onClick={() => { if (step === 5) { markTutorial("completed"); changeMode(false); } else setStep(s => s + 1); }}>{step === 5 ? "完成教學" : "下一步"}</button></div> : null}
      <p className="field-note">紀錄只保留在目前瀏覽器，最多 10 個版本／50 次實驗；達上限會停止新增，不會刪除舊紀錄。清除網站資料或關閉無痕視窗會失去紀錄；可匯出 CSV 交給老師。</p>
      {storageWarning ? <p role="alert">{storageWarning}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
    </section>
    {(!tutorial || step < 4) ? <>
      <section className="panel learning-version-bar" aria-label="設計版本">
        <label>編輯版本<select aria-label="編輯版本" value={version.label} disabled={busy} onChange={event => { setSelected(event.target.value); setPrediction(""); setRevision(r => r + 1); }}>{book.versions.map(v => <option key={v.label}>{v.label}</option>)}</select></label>
        <button disabled={busy || book.versions.length >= 10} onClick={() => { const next = copyVersion(book, version.label); update(() => next); setSelected(next.versions.at(-1)!.label); setPrediction(""); setRevision(r => r + 1); }}>複製此版本</button>
        <button disabled={busy} onClick={() => update(previous => ({ ...previous, versions: previous.versions.map(v => v.label === version.label ? { ...v, saved: cloneDesign(v.draft) } : v) }))}>保存版本</button>
        <button disabled={busy} onClick={() => { update(previous => ({ ...previous, versions: previous.versions.map(v => v.label === version.label ? { ...v, draft: cloneDesign(v.saved) } : v) })); setRevision(r => r + 1); }}>還原已保存版本</button>
        {!tutorial ? <button disabled={busy || !editorValid || !validateDesign(version.draft).valid} onClick={() => onAdopt(cloneDesign(version.draft))}>帶回設計室</button> : null}
      </section>
      <DesignerPage key={`${tutorial}-${version.label}-${revision}`} initialDesign={version.draft} persistDraft={false} practiceMode onReadinessChange={setEditorValid} onDesignChange={next => update(previous => { const current = previous.versions.find(v => v.label === version.label); return current?.draft === next ? previous : { ...previous, versions: previous.versions.map(v => v.label === version.label ? { ...v, draft: next } : v) }; })} />
      <section className="panel learning-comparison" aria-label="版本比較">
        <h2>版本比較</h2><label>比較基準<select aria-label="比較基準" value={other.label} onChange={event => setCompare(event.target.value)}>{book.versions.map(v => <option key={v.label}>{v.label}</option>)}</select></label>
        <p>{other.label} → {version.label}：{differences.length} 個參數差異</p>
        {differences.length ? <ul>{differences.map(d => <li key={d}>{d}</li>)}</ul> : <p>造型與裝配參數相同。</p>}
        <div className="learning-previews"><figure><TopViewSvg design={other.draft} /><figcaption>基準 {other.label}</figcaption></figure><figure><TopViewSvg design={version.draft} /><figcaption>版本 {version.label}</figcaption></figure></div>
      </section>
      <section className="panel" aria-label="固定條件測試"><h2>預測與測試</h2><p>固定對手：預設陀螺；雙方力度：Great（1 倍）；種子：314159。結果來自物理模型，不是實物量測；10 秒動畫是演出時間。</p>{book.records.length >= 50 ? <p role="status">已達 50 次實驗紀錄上限，請匯出 CSV 保留紀錄。</p> : null}<label>我的預測<textarea maxLength={500} value={prediction} disabled={busy} onChange={event => setPrediction(event.target.value)} placeholder="我預測……，因為……" /></label><button disabled={busy || book.records.length >= 50 || !editorValid || !prediction.trim() || !validateDesign(version.draft).valid} onClick={() => void test()}>{busy ? "背景運算中……" : "測試此版本"}</button>{busy ? <button onClick={() => { controller.current?.abort(); setBusy(false); }}>取消測試</button> : null}</section>
      <section className="panel" aria-label="實驗紀錄"><h2>我的實驗紀錄</h2><button disabled={!book.records.length} onClick={exportCsv}>匯出實驗 CSV</button>{!book.records.length ? <p>先寫下預測，再執行一次測試。</p> : null}
        {[...book.records].reverse().map(record => <details key={record.id} open={record === book.records.at(-1)}><summary>版本 {record.version} · {new Date(record.at).toLocaleString("zh-HK")} · {record.result.winner === "player1" ? "測試設計勝出" : record.result.winner === "player2" ? "固定對手勝出" : "平手"}</summary><p>預測：{record.prediction}</p><p>模型時間 {record.result.seconds.toFixed(2)} 秒／碰撞 {record.result.contacts} 次／最後角速度 {record.result.angularSpeed.toFixed(2)} rad/s</p><p className="field-note">模型：{record.result.modelVersion}；設計與結果已以測試當時的副本保存。</p>{(["observation", "nextTest"] as const).map(field => <label key={field}>{field === "observation" ? "我的觀察" : "下次想測甚麼"}<textarea maxLength={500} value={record[field]} onChange={event => update(previous => ({ ...previous, records: previous.records.map(r => r.id === record.id ? { ...r, [field]: event.target.value } : r) }))} /></label>)}</details>)}
      </section>
    </> : null}
    {tutorial && step === 4 ? <PracticeBattle design={practice.versions[1]?.draft ?? practice.versions[0]!.draft} reducedMotion={reducedMotion} gameAudio={gameAudio} onReturn={() => setBattleReturned(true)} /> : null}
    {tutorial && step === 5 ? <section className="panel"><h2>由設計到製作</h2><p>完成教學後回到設計室，才會使用真正的下載／傳送按鈕。這次練習無需下載或上載檔案。</p></section> : null}
  </main>;
}
