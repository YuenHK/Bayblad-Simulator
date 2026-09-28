# 創客工作台實作計劃

> **面向 AI 代理的工作者：** 使用 `superpowers:executing-plans` 在當前對話逐項執行；採內聯執行，不重用先前停止的協作代理。步驟以核取方塊記錄，正式修改前使用 TDD，宣稱完成前使用 verification-before-completion。

**目標：** 將已確認的設計室與資源頁尾套用至正式前端，保留全部既有功能及資料行為。

**架構：** DesignerPage 繼續持有唯一 useDesigner 狀態及既有參戰 callback。把層板選取、工具切換與預覽位置拆成展示元件，既有計算、SVG／3D、匯出及輪廓處理保持不變。工具採保留掛載、隱藏非作用中面板的方法，避免切換時清除草稿；資源頁尾獨立成純展示元件。

**技術棧：** React、TypeScript、CSS、Vitest／Testing Library、Playwright、pnpm 11、Node 24。

**核准規格：** `docs/superpowers/specs/2026-09-28-maker-workbench-design.md`，使用者已明確回覆「確認」。

**工作目錄：** `/Users/cywong/Documents/Codex/Bayblad-Simulator-20260911`。不要使用對話掛載的舊 Google Drive 儲存庫；兩者 Git common dir 不同。已核實目前分支 `codex/shapecut-handoff`，功能基線 `1a238b6`；其後目前僅有文件提交。未追蹤 `.superpowers/` 是使用者正在查看的本機原型，不加入提交、不刪除、不推送。

---

## 檔案與职责

### 執行狀態（2026-09-28）

- 任務 1–6 已實作；新增保全契約集中於 `MakerWorkbench.test.tsx`，先確認紅燈，再完成綠燈。展示元件互相依賴，本輪採完整驗證後一次提交，未逐個中間狀態提交。
- 已通過 `pnpm lint`、`pnpm typecheck`、`pnpm build`、`pnpm test`：1,257 項通過、32 項資料庫環境相關測試略過；PostgreSQL 專項留待 CI 真實服務驗證。
- 內容斷點調整為 900px；200% 可讀性以 720×450 的等效 CSS viewport 加 reduced-motion 測試，不將 CSS zoom 或模擬器稱為實體裝置驗收。
- 唯讀程式審查提出的手機畫布導航及工具面板語義問題已修正；新增手機能力值垂直排列與未套用草稿切換／重排回歸。
- 任務 7 已完成：46 項一般 E2E 及另跑 3 項完整時長對戰均通過。任務 8 即將執行。下列核取方塊保留原始逐步要求，最終驗收以 `2026-09-28-maker-workbench-acceptance.md` 為準。

| 檔案 | 工作 |
| --- | --- |
| `apps/web/src/features/designer/DesignerPage.tsx` | 工作台組合、面板選取、錯誤導向及唯一設計狀態 |
| `apps/web/src/features/designer/LayerRail.tsx`（新） | 選層縮圖與排序控制；沿用既有排序 callback |
| `apps/web/src/features/designer/WorkbenchTabs.tsx`（新） | 有鍵盤導航的展示分頁，不儲存設計資料 |
| `apps/web/src/features/designer/LayerControls.tsx` | 保留草稿及基礎／自定切換，支援中央畫布插槽 |
| `apps/web/src/features/designer/CustomOutlineEditor.tsx` | 可把既有畫布呈現至穩定插槽，幾何邏輯不變 |
| `apps/web/src/features/designer/makerWorkbench.css`（新） | 限定工作台範圍的格線、響應式與面板顯示 |
| `apps/web/src/features/project/ProjectResources.tsx`（新） | 三個真實資源連結及用途說明 |
| `apps/web/src/features/project/projectResources.css`（新） | 資源列橫排／直排及焦點樣式 |
| `apps/web/src/App.tsx` | 以 ProjectResources 取代現有頁尾；仍只在非房間畫面顯示 |
| `apps/web/src/features/designer/DesignerPage.test.tsx` | 工具、選層、草稿與既有計算回歸 |
| `apps/web/src/features/designer/CustomOutlineEditor.test.tsx` | 畫布插槽與 pointer 行為 |
| `apps/web/src/App.test.tsx` | 資源列連結及 room 時不顯示 |
| `tests/e2e/maker-workbench.spec.ts`（新） | 跨尺寸、鍵盤、草稿與隱藏錯誤 |
| `tests/e2e/designer.spec.ts`、`designer-compact.spec.ts`、`responsive.spec.ts`、`custom-outline.spec.ts`、`designer-export.spec.ts` | 調整已改版的操作定位，保留功能斷言 |
| `tests/e2e/project-links.spec.ts`、`teacher-entry.spec.ts` | 頁尾新結構與舊 URL 契約 |
| `tests/public-e2e/public-acceptance.spec.ts` | 正式部署後的新介面公開驗收 |

## 任務 1：建立切換保全的失敗測試

- [ ] 執行 `git status --short`、`git log -5 --oneline`，確認沒有其他人修改目標檔案。讀取本規格及相關測試，保留 `.superpowers/`。
- [ ] 在 DesignerPage.test.tsx 加入以下操作契約；新工具分頁在現有程式不存在，應先失敗：

```tsx
it("切換工具不會清除無效裝配輸入", async () => {
  const user = userEvent.setup();
  render(<DesignerPage onUseDesign={vi.fn()} />);
  await user.click(screen.getByRole("tab", { name: "共用裝配" }));
  const count = screen.getByRole("spinbutton", { name: "螺絲數量" });
  await user.clear(count);
  await user.type(count, "9");
  await user.click(screen.getByRole("tab", { name: "層板造型" }));
  expect(screen.getByRole("button", { name: "規格未通過，請先修正" })).toBeDisabled();
  await user.click(screen.getByRole("button", { name: "前往共用裝配修正" }));
  expect(screen.getByRole("spinbutton", { name: "螺絲數量" })).toHaveValue(9);
  expect(screen.getByRole("spinbutton", { name: "螺絲數量" })).toHaveAttribute("aria-invalid", "true");
});
```

- [ ] 加入按「編輯頂層／中層／底層」切換的測試：頂層直徑輸入 81（無效）、切中層再切回，仍顯示 81 並禁止參戰。這是新 UI 所需的保全契約，不將無效值寫入 domain。
- [ ] 在既有自定輪廓測試上追加：畫出未套用草稿，切裝配、切層、重排、返回原層，原草稿點數不變且未套用前正式 preview 不變。
- [ ] 執行 `pnpm --filter @steam-top/web exec vitest run src/features/designer/DesignerPage.test.tsx`；記錄新分頁／選層按鈕缺失或草稿被重設的失敗，不接受編譯或環境錯誤代替紅燈。

## 任務 2：穩定工具面板與可及分頁

- [ ] 新建 WorkbenchTabs，props 為 `items: ReadonlyArray<{id:string;label:string;panelId:string}>`、`value:string`、`onChange:(id:string)=>void`、`label:string`、`idPrefix:string`。按鈕使用 role=tab、aria-selected、aria-controls、roving tabIndex；方向鍵循環，Home／End 跳首尾並移焦點。不同分頁組使用不同 idPrefix。
- [ ] DesignerPage 工具狀態使用 `"shape" | "assembly"`，窄螢幕狀態使用 `"preview" | "shape" | "assembly"`。桌面與窄螢幕切換同步工具選取，但不建立第二份設計。
- [ ] 每層各保留一個以 layer.id 為 key 的 LayerControls，非作用中層用 hidden 隱藏，不用位置作 key；AssemblyControls 始終掛載。結構模式如下：

```tsx
{design.layers.map((layer) => (
  <div key={layer.id} hidden={selectedLayerId !== layer.id || tool !== "shape"}>
    <LayerControls
      layer={layer}
      screwLayout={design.screwLayout}
      dispatch={dispatch}
      onFieldValidityChange={updateFieldValidity}
    />
  </div>
))}
<div hidden={tool !== "assembly"}>
  <AssemblyControls design={design} dispatch={dispatch} onFieldValidityChange={updateFieldValidity} />
</div>
```

- [ ] 不修改 NumericField 的有效值／錯誤契約；隱藏不觸發其 unmount cleanup。表單測試改用可見角色查詢 `getByRole("spinbutton", {name: ...})` 或作用中區域範圍，不用全頁 getByLabelText 選中隱藏欄位。
- [ ] 依 invalidFieldKeys 的 `assembly:` 前綴或 layer.id 定位錯誤。提供「前往共用裝配修正」或「前往頂層／中層／底層修正」按鈕；點擊切換面板，下一 animation frame 聚焦該面板第一個 `[aria-invalid="true"]`。錯誤仍阻止所有相關操作。
- [ ] 重跑任務 1 測試至綠燈，再 `git diff --check`，僅提交本任務明確檔案。

## 任務 3：層板縮圖與排序

- [ ] 新建 LayerRail，使用既有 `layerPath` 畫縮圖；縮圖 aria-hidden，不新增重複的 SVG IDs 或正式 preview 的 test IDs。外層保留「三層排列」清單。
- [ ] 每層提供 `aria-label="編輯頂層"` 等按鈕與 aria-pressed。拖曳把手與選層按鈕為同級，不能互相巢狀。
- [ ] 從 DesignerPage 移入原有排列 JSX，保留 pointer capture、cancel、window pointerup、elementFromPoint 及按 layer ID 重排的 callback；移除重複的「目前編輯層」select。
- [ ] 保留「將目前層上移／下移」及邊界 disabled；手機不能隱藏。拖曳後仍以 ID 選取原層，aria-live 讀出新位置。
- [ ] 更新既有排序測試的選層操作，不移除 pointer release／取消斷言。新增選層後上移仍保留無效欄位與未套用輪廓的測試。
- [ ] 執行 `pnpm --filter @steam-top/web exec vitest run src/features/designer/DesignerPage.test.tsx src/features/designer/TopViewSvg.test.tsx`，綠燈後提交。

## 任務 4：中央自由繪畫插槽

- [ ] 讀完 CustomOutlineEditor.tsx，先新增插槽測試，驗證 canvas 在目標元素內且仍能套用／撤銷。保留原本單獨使用編輯器時的內嵌畫布。
- [ ] 編輯器新增可選 `canvasHost?: HTMLElement | null`；只把現有 SVG 節點放進 React portal，不重寫 pointer、鏡像、預覽、驗證算法：

```tsx
import { createPortal } from "react-dom";
// canvas 為原有完整 SVG JSX；保留全部事件與幾何。
const renderedCanvas = canvasHost ? createPortal(canvas, canvasHost) : canvas;
```

- [ ] 每層在中央區建立穩定、不因工具切換卸載的 host；callback ref 儲存後不因隱藏切換到另一 host。未选取層的 host hidden，避免多個編輯器疊畫。
- [ ] LayerControls 新增 mode 通知及 canvasHost prop，通知僅在 mode 改變時執行；mode 仍由每層草稿控制，不改套用語义。自定造型時提供「編輯輪廓／預覽成品」，使未套用草稿與已套用幾何明確分開。
- [ ] 手機「前往畫布／返回造型工具」只改面板可見狀態，不清空 pointer 以外的草稿。正在拖曳時切換／取消仍依現有 pointercancel 處理。
- [ ] 執行 `pnpm --filter @steam-top/web exec vitest run src/features/designer/CustomOutlineEditor.test.tsx src/features/designer/DesignerPage.test.tsx`；確保既有自交、超量點數、孔位及套用檢查不退化，再提交。

## 任務 5：工作台響應式與真實操作區

- [ ] 引入 makerWorkbench.css，作用域使用 `.game-designer.maker-workbench`，避免更改 room/admin。使用既有 font／color token，不複製原型全域 body 或 button 規則。
- [ ] >=1100px 三欄 `132px minmax(0,1fr) 340px`；760–1099px 三欄 `100px minmax(0,1fr) 300px`；<760px 單欄。若可用寬度不足，按內容斷點提早轉單欄；不為保持三欄造成橫向溢出。
- [ ] 舊 compact CSS 的 grid-row、grid-column、固定高度與工作台頁籤隱藏規則須在新作用域明確覆蓋。preview、工具與結果的焦點可及性以實際 computed display 驗證，不只看 aria。
- [ ] 七個能力值、驗證訊息及 DesignExportControls 位於全寬結果區，維持真實數據。參戰只有一個主按鈕；保留下載與 ShapeCut 狀態／備援連結和既有錯誤說明。
- [ ] 窄螢幕頁籤不遮蓋變高的 navbar，不強制固定頁面高度；結果不再被舊「預測結果」頁籤隱藏。短螢幕自然捲動，所有觸控目標至少 44px。
- [ ] `pnpm --filter @steam-top/web exec vitest run src/features/designer`，再 typecheck／lint 通過後提交。

## 任務 6：專案與工具資源列

- [ ] 在 App.test.tsx 為三個入口加入用途說明、真實 href、新分頁及 rel 測試；教師連結保留既有 /admin/ URL，沒有口令 query。先觀察現有資源列標籤測試紅燈。
- [ ] 建立 ProjectResources 純展示元件。外層保留 `aria-label="專案與更多作品"` 以延續既有可及名稱；內部展示 ARENA LAB／專案與工具。
- [ ] 三個 anchor 分別包含圖示（aria-hidden）、標題、副標。GitHub 可保留原有 `#readme`，其他 URLs 與已確認規格一致。可及名稱以標題為準，新分頁資訊共用說明。
- [ ] 三欄等權重，不為教師入口加特別實心按鈕；手機直排。原有字體與色彩 token 保留，用 margin、padding、grid 與邊界分組。
- [ ] App 僅以 `<ProjectResources />` 替換 `page !== "room"` 內頁尾，連線、音效與身份流程不動。
- [ ] 執行 `pnpm --filter @steam-top/web exec vitest run src/App.test.tsx`，綠燈後提交。

## 任務 7：完整驗收與畫面檢查

- [ ] 更新既有 E2E 中「目前編輯層」與舊三頁籤的選擇器，採用新可見角色；不得刪除匯出、造型、戰鬥、教師功能斷言來達成通過。
- [ ] 新增 maker-workbench.spec.ts：對規格六種尺寸逐一檢查無橫向溢出、所有工具可到達、上下移可操作，並保存每種尺寸的畫面。

```ts
await expect.poll(() => page.evaluate(() =>
  document.documentElement.scrollWidth <= window.innerWidth
)).toBe(true);
```

- [ ] 瀏覽器自定造型流程：畫有效輪廓但不套用，切裝配、切層、重排、返回；草稿仍在，套用後 SVG、3D、重量更新。測試隱藏無效數字仍禁止匯出和參戰，返回修正後恢復。
- [ ] 執行 `pnpm exec playwright test tests/e2e/maker-workbench.spec.ts tests/e2e/designer.spec.ts tests/e2e/designer-compact.spec.ts tests/e2e/responsive.spec.ts tests/e2e/custom-outline.spec.ts tests/e2e/designer-export.spec.ts tests/e2e/project-links.spec.ts tests/e2e/teacher-entry.spec.ts --project=student`。
- [ ] 目視檢查桌面、橫直 iPad 模擬及手機截圖，實測 200% 放大、鍵盤 Tab／方向鍵及 reduced-motion。不能把模擬尺寸稱為實體 iPad 測試。
- [ ] 依序執行 `pnpm test`、`pnpm typecheck`、`pnpm lint`、`pnpm build`、`pnpm test:e2e`。效能測試避免與其他重負載並行，不放寬時間上限。
- [ ] 讀取最終 diff，确认未改 domain、protocol、server、資料庫、權限或戰鬥規則。記錄所有測試的實際結果，不沿用歷史測試數。

## 任務 8：部署閘門及交付

- [ ] 核實本輪實作及完整驗收完成，再按既有批准部署流程推驗證分支；驗證 GitHub CI 安全檢查全部成功後才合併 main。不得把 `.superpowers/`、測試資料、憑證或日誌推送。
- [ ] 本次若僅修改學生前端，部署 GitHub Pages 即可；不重啟或暫停 Render，不做資料庫操作。若意外需要後端改動，先停止擴大範圍並報告原因。
- [ ] 核實 Pages workflow 指向實作 SHA，公開資產版本匹配。公開學生 Chrome／Firefox／WebKit iPad 模擬／手機模擬流程驗收，確認三個資源 URL、設計、STL／ShapeCut 及參戰流程。
- [ ] 如遇登入或部署控制失效，只記錄精確阻擋並通知，不自行改用憑證／安全繞過方式。
- [ ] 交付公開網址、實際驗收結果與已知限制。保留原型供比較，不宣稱實體製造或實體 iPad 已驗收。

## 計劃自檢

- 規格的三欄、窄螢幕、七項數值與可及性：任務 2、3、5、7。
- 原型未包含的正式星形、草稿保全、手機排序、隱藏錯誤及真實 3D：任務 1–5、7。
- 資源列與現有功能連結：任務 6–8。
- 無資料／後端修改、測試與部署分開：任務 7–8。
- 原始計劃的核取方塊作為逐項要求留存；即時進度見上方「執行狀態」，交付時另附實際驗收結果。
