# 三層板材 STL 下載實作計劃

> **面向 AI 代理的工作者：** 使用 executing-plans 在本工作區內逐項執行；用測試驅動開發及完成前驗證，不另行委派。

**目標：** 設計室下載只含三層板材的 STL，交給 ShapeCut 製作 DXF。

**架構：** 按下按鈕才載入匯出器。沿用 domain 的裁切後輪廓，按 bottom/middle/top 放在 Z=0/6/12 mm，布林聯集去除接觸內面，輸出二進位 STL。所有運算留在瀏覽器；不匯出五金、不改設計資料或原有介面字體顏色。

**技術棧：** TypeScript、React、Manifold WASM、Vitest、Playwright。

## 已批准規格

- 只輸出三層板材，每層 6 mm，數值單位 mm；保留輪廓、孔位與上下排序。
- 不含金屬圓片、螺絲或軸心。內部接觸面不屬於外殼，匯出時去除。
- 下載按鈕使用現有樣式；文字說明 mm / 6 mm，以及前往 ShapeCut 的連結。
- 未完成或無效欄位禁止下載，避免偷偷輸出上一次合法數值；重量只限制對戰，不限制離線模型下載。
- 失敗顯示可重試訊息，不產生空檔；釋放 WASM 物件及 Blob URL。
- ShapeCut 可能另加發射器孔位；不承諾製造適配，實切前須核對及試切。

## 檔案與步驟

### 1. 幾何匯出

- 建立 `apps/web/src/features/designer/exportBoardsStl.test.ts`，先驗證缺失實作失敗。
- 建立 `exportBoardsStl.ts`：`exportBoardsStl(design: TopDesign): Promise<ArrayBuffer>`。
- 測試 STL 長度 `84 + triangleCount * 50`、Z=0..18、每層中間截面的直徑、孔洞、所有邊恰有兩個反向面、金屬參數不影響輸出、排序改變幾何、非法數值拒絕。
- 執行 `pnpm --filter @steam-top/web exec vitest run src/features/designer/exportBoardsStl.test.ts`，先紅後綠。

### 2. 設計室下載

- 建立 `DesignExportControls.tsx` 及單元測試；修改 `DesignerPage.tsx` 在工作區下方獨立面板加入元件，不推低原有參數及參戰按鈕。
- 動態 `import('./loadBoardsStl')`；產生 `model/stl` Blob，檔名 `bayblad-3layers-6mm-mm.stl`，延後釋放 URL。純幾何模組 `exportBoardsStl.ts` 接收已初始化引擎，供相同實作的單元測試使用。
- 元件測試下載狀態、失敗可重試、欄位無效禁用；DesignerPage 測試整合。
- 新增 `tests/e2e/designer-export.spec.ts`，實際接收 download 並讀回 STL，確認未下載前沒有 WASM 請求。

### 3. 相容性與交付

- 將實際下載檔送進 ShapeCut 正式版，檢查三層輪廓與 DXF 下載；記錄限制，不修改 ShapeCut。
- `pnpm typecheck`、web 單元測試、designer compact / export E2E、student build。
- 更新 README 使用說明，審閱 diff；提交並快轉推送 main，等 Pages 成功。
- 在正式學生網站實際下載一次；後端沒有變更，不重啟 Render。

## 完成紀錄

- [x] 幾何與單元測試
- [x] 介面與下載測試
- [x] ShapeCut 程式碼相容性驗證：commit `8b616e2b36148c41df5836c5015fbfdf6ae972d8`，精確切片、三層各 6 mm、11,984 三角面，沒有破面／自相交；已產生 DXF 並通過 `verifyOutlinePackage` 一致性檢查。ShapeCut 提示省略部分裝飾；正式 Chrome 上載受擴充功能檔案 URL 權限阻擋，不能聲稱公開版 UI 匯入已驗收。
- [ ] 回歸、部署與正式網站驗證

獨立唯讀審查無阻擋問題；已補上審查指出的窄螢幕實際下載，以及正向體積／交界內面檢查。保持所有原有字體、字級及配色不變，只有新增下載面板的間距及連結沿用既有色彩。
