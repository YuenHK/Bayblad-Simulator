# 自定輪廓實作計劃

> 面向 AI 工作者：使用 subagent-driven-development 逐項實作及兩階段審查。所有測試先觀察紅燈，再實作。不得把部分完成版本部署到公開網站。

**目標：** 實作已批准的 `../specs/2026-09-27-custom-layer-outlines-design.md`。
**架構：** 純幾何工具與輪廓驗證先獨立完成，再將 custom 分支接到 domain、資料庫／協定及介面。預覽、對戰與輸出共用同一輪廓；舊資料走原有分支。
**技術棧：** TypeScript、Zod、React、SVG pointer events、Three.js、PostgreSQL、Vitest、Playwright。
**工作位置：** `/Users/cywong/Documents/Codex/Bayblad-Simulator-20260911`，既有非 main 工作分支。不要使用過期的 adc8 checkout；不 push main，直至全鏈路驗收完成。

## 接駁稽核（2026-09-27）

### 本機實作檢查點

- 2026-09-27 22:57：28041ee 品質 CI36323710040、PostgreSQL CI36323710010 均 success。本輪加入 Socket auth `customOutlineVersion:1` 能力檢查，在 welcome／session／重播前拒絕舊 decoder；保留 protocol v1 的 unsupported envelope，中文要求重新整理。已觀察舊客戶端測試先紅（原本收到 welcome），修正後 server 36、client 36 通過；同步 load 與 production-wss-smoke 客戶端。教師高低分參數表新增表現／物理模型版本，標為歷史表現、非最佳解，修正類別翻譯。完整 pnpm test 通過（domain191、protocol98、web193、DB21、server517、integration/CI211；32 skipped），後加 refresh reason 測試及 smoke capability 測試分別通過；pnpm build、typecheck 通過；真 Socket 自定對基本三角色完整快測 28 秒通過。
  **剩餘 Important 規格缺項：** 獨立審查確認目前沒有「歷史紀錄中的高分設計」列表／縮圖，只有參數群組統計及學生累積分排行榜。不是 `queryLeaderboard` 少 outline：該投影只作篩選，response 無 design。下一步新增小型高分設計來源與教師 UI，按 design ID＋表現／物理版本分組，列樣本數／平均分／完整幾何，重用 LayerRecord；不要以前端排序目前分頁冒充全體高分。之後最終驗收、實際 Render／備份／additive DB 後端優先部署、Pages 及公開驗收。無正式部署。
  發佈順序注意：此 gate 是 decoder 能力，不是身份授權；後端切換後舊前端會被要求更新，須完成全部驗收再協調後端與 Pages 發佈，不單独把 gate 部署。實體 iPad／試切仍未驗證。

- 2026-09-27 21:49：75a4d0d品質CI36320542863及PostgreSQL CI36320542864皆success。`CINEMATIC_BATTLES=1 ... playwright test tests/e2e/cinematic.spec.ts --grep 'custom computer'` 通過完整自定凹形人機對戰：30秒每輪、Miss最低力、召喚／決勝／粉碎／結算、返回同房再準備（約1.4分鐘）。新增basic/custom兩種cinematic案例，普通CI仍按原設定跳過完整長播，需上述指令明確執行。三角色真Socket測試改為自定對基本造型，完成讓位、觀眾可見兩人判定、玩家判定私隱、三輪結算及賽後分數，通過（此案例是快速測試引擎，不是30秒動畫證據）。E2E typecheck通過。下一步優先新舊客戶端相容及最終品質審查，再核實正式部署入口；仍未部署。

- 2026-09-27 20:54：真實ShapeCut接收測試發現pointer浮點輪廓導致STL `Degenerate STL face`。已用實際輪廓座標重現單元紅燈，匯出union後以Manifold.simplify(0.0001 mm)處理浮點退化，再保留status／正面積檢查；不是刪除三角面。8項STL封閉邊／正向體積／內部面測試及191項web tests通過。真實本機ShapeCut基本1280／390接收、自定凹形接收→選6mm材料→轉換完成→3切片→blob ZIP連結，共3項通過。接收端用 `/Users/cywong/Documents/Codex/ShapeCut-related-links`，先 `SHAPECUT_BASE_PATH=/ShapeCut/ npm run build`；sender用 `STEAM_TOP_PAGES_BASE=/steam-top/ pnpm --filter @steam-top/web build:student`，再 `SHAPECUT_DIST=/Users/cywong/Documents/Codex/ShapeCut-related-links/dist pnpm exec playwright test --config playwright.handoff.config.ts`。沒有修改ShapeCut源碼；未驗證實際切割。尚須客戶端握手相容、完整custom對戰、品質審查及正式部署驗收。

- 2026-09-27 19:48：4bdc9ef品質CI36313582772及PostgreSQL CI36313582931皆success。已加入左右／上下／4／6／8／12鏡射的真實滑鼠瀏覽器測試，驗證可套用及跨層草稿隔離／恢復；加上原有desktop/touch案例共8項通過，E2E typecheck通過。下一步可從 `playwright.handoff.config.ts` 和 `tests/support/shapecut-static-server.mjs` 開始 custom STL→真實ShapeCut接收測試；現有handoff只測基本造型及接收至材質選擇，不能當作custom切片驗收。握手相容、完整custom對戰及最終審查仍未完成，未部署。

- 2026-09-27 18:46：5432e80的品質CI36310375030及PostgreSQL CI36310375044皆success。新增 `tests/e2e/custom-outline.spec.ts`：1440px真實滑鼠輸入及390px Chromium CDP touch輸入畫封閉輪廓、套用層板、無橫向溢出，兩項通過；E2E TypeScript檢查通過。這是模擬觸控，非實體iPad。尚需鏡射模式的瀏覽器案例、新舊客戶端相容、custom ShapeCut接收與完整對戰、審查及公開部署驗收。

- 2026-09-27 17:45：f48615a 品質 CI36307250469 與 PostgreSQL CI36307250424 皆 success；包括compact Linux E2E。新增記憶體人氣設計 key 的 canonical 化：自定輪廓起點／順逆／鏡像編輯方式及無效的 points/roundness 不再拆分人氣；尺寸採持久化精度，旋轉／實際輪廓／裝配差異保留。先重現失敗再修正，完整server516 tests及typecheck通過。待審查和新CI。仍須處理新舊客戶端相容、custom畫布觸控E2E、ShapeCut接收、完整自定輪廓對戰及發佈驗收；不可因現有CI綠燈而跳過新增功能驗收。

- 2026-09-27 16:47：4399dd5 的 PostgreSQL run36304002803 成功（包含 custom 重載及重存去重）；品質 run36304002783 單元測試通過，E2E 唯一失敗是1024×768參戰按鈕超出畫面。已重現並修正：造型切換置於 legend 同行，矮螢幕只縮間距，不改字體大小／顏色。重新建置後1440×900、1024×768兩項瀏覽器測試通過，34項編輯器／設計頁測試及web typecheck通過；已檢視1024截圖。仍須Linux CI驗證及自定畫布手機／觸控、握手相容、ShapeCut和對戰驗收。尚未部署。

- 2026-09-27 15:44：PostgreSQL CI `36300884707` 最終 success；品質 CI `36300884651` 因舊 upload fixture 的 4 tests 失敗，修正已在 3e4e0a0。本輪根目錄 `pnpm test` 完整 exit 0：domain191、protocol98、web190、DB21、server514、integration/CI211，另32項跳過（不能當成通過）。新增 custom PostgreSQL reload／precision dedup regression，commit4399dd5 已推送獨立驗證分支，等待新 CI 結果；無正式部署。下一輪先查 `gh run list --branch codex/custom-outline-validation`，再處理握手能力相容、人氣 canonical signature、編輯器 E2E／ShapeCut／完整對戰及審查。

- 2026-09-27 14:44：已把 c418659 推送至獨立遠端分支 `codex/custom-outline-validation`，非 main，沒有部署。GitHub PostgreSQL run `36300884707` 的 DB/server PostgreSQL、cutover migration、platform installation、build 步驟均成功；完整 job 尚在運行，下一輪須讀取最終結果及另一個 CI run `36300884651`。這是隔離 CI 證據，不是正式主機 bootstrap 驗收。新增不對稱凹形 custom STL 封閉邊／正向體積／內部面測試（7 項通過）；全前端測試發現 upload fixture 仍宣告舊模型 1.0.0，已更新至 1.1.0。新舊客戶端握手相容仍未實作，不能據此發佈。

- 2026-09-27 13:42：新增 `0006_custom_outline_installation_guard.sql`，保留既有函數的所有 schema／ACL／空資料安全檢查，只將精確 ledger IDs／hashes 擴充至 0006。正式 runner、journal、claim 的函數 hash 來源及測試 fixture 已同步；既有 0000–0005 未修改。8 項 migration runner 及 21 項 DB 單元測試通過，shell syntax／diff check 通過。**仍未在 PostgreSQL 執行，不能視為已解除發佈阻擋**。下一步以隔離 PostgreSQL 或非部署分支 CI 驗證 fresh claim 和 upgrade，並審查新 migration；不可執行破壞性 fixture 於生產 DB。

- 幾何、domain、公開輪廓協定、碰撞輪廓及編輯器已提交；編輯器提交為 `947bd60`，尚待瀏覽器及完整流程驗收。
- 已修正正式 migration manifest 遺漏 0005，以及 custom 直徑需對齊 PostgreSQL numeric(7,3) 精度；新增回歸測試先失敗再通過。
- **發佈阻擋項：** `restore_control.assert_pristine_platform_installation()` 在 0004 寫死五筆 migration ledger。新增 0005 後，首次 installation claim 會拒絕；需新增相容的函數定義及更新 claim 的 canonical hash 來源，不能修改既有已發佈 migration 或取消安全檢查。必須實際 PostgreSQL 驗證。
- 教師統計／Excel 的造型類別及鏡像欄位已開始；教師記錄 SQL 與 UI 輪廓縮圖、客戶端版本相容提示、人氣設計 canonical signature、STL／ShapeCut／完整對戰驗收仍未完成。
- 尚未 push 或部署本次功能；不可把局部單元測試結果視為全鏈路或公開網站驗收。
- 2026-09-27 12:41 接續：教師記錄 SQL 已保留 outline，自定 points 為 null；新增 LayerRecord 縮圖與鏡像顯示，原有基本造型文字保留。教師 UI 7 tests、記錄／統計／Excel 19 tests 及全專案 typecheck 通過。SQL 目前僅投影契約測試，仍須實際 PostgreSQL 整合驗證；尚未部署。下一步優先處理上述首次安裝 migration ledger 相容問題，之後補完整 E2E 及品質審查。

- `apps/server/src/battle/collision-proxy.ts` 的 sensor outline 是徑向 star-shaped union，不能直接把 custom 傳入 `radialFactor`。須為含 custom 的設計採真實多邊形 union 外邊界；保留原有凸碰撞代理作近似剛體，不把它用作外觀或面積。
- `apps/server/src/socket.ts:1100` 會拒絕雙方 performanceModelVersion 不同。新模型版本應為所有新計算統一升版，基本造型數值保持不變；不可只把 custom 升版令其無法與基本造型對戰。歷史紀錄不改，舊儲存設計參戰時產生新版本快照。
- `layerSchema.extend/pick` 與 Zod object refinements 有相容限制；使用 `safeExtend` 或抽取共用 fields 後在各完整入口驗證，加入缺少輪廓不能透過 geometry pick 驗證的反例。
- `design_layers` 啟用後資料不可修改的 trigger 應保留；migration 只新增 nullable 欄位，不改舊列。PG enum 新值的使用注意 transaction 可見性，以 `shape::text` 作新增 CHECK 比較或分隔 migration transaction。
- 目前 `calculateMinimumMaterialNeckMm` 已用真實線段至孔位距離，適合凹形；另一路 `minRadialThickness` 不適用任意凹形，不應誤用於新功能。
- STL 目前使用 Manifold 並將三層 union 成一個實心輸出；沿用既有行為，驗收每層截面，而非要求三個獨立 mesh。

## 任務 1：獨立輪廓工具

新增 `packages/domain/src/customOutline.ts` 與 `customOutline.test.ts`，暫不增加任何 UI 入口或改動現有 design schema。

API：`validateCustomOutline(points)` 回傳具體錯誤碼；`canonicalizeOutline(points)` 返回 CCW、從字典序最小座標開始的頂點陣列；`reflectOutlineStroke(stroke, mode)` 接受 none/leftRight/topBottom/4/6/8/12；多軸模式以第一個正角度扇區為輸入，交替反射。所有運算保留毫米座標及原點，不作質心置中或凸包。

- [ ] 寫測試：矩形、含原點的凹形、偏心輪廓有效；bow-tie、自接觸、退化邊、NaN、超過 256 點、半徑超過 40、軸孔外露無效。軸孔半徑 3.25 mm，要求正的實心餘量。
- [ ] 正規化測試：起點循環移動、順逆方向得到同結果，不改尺寸與偏心；不得改變原輸入。
- [ ] 鏡像測試：左右、上下、4/6/8/12 扇區逐一檢查反射對應、接縫單點、相同半徑範圍；非法扇區／端點拒絕，不默默吸附遠離邊界的輸入。輸入端點吸附由 UI 負責。
- [ ] `pnpm --filter @steam-top/domain exec vitest run src/customOutline.test.ts` 先驗證失敗，再最小實作，再確認通過；跑 domain 全測試及 typecheck。
- [ ] 規格審查、品質審查、修正、commit。

## 任務 2：共用設計、計算及協定

修改 `packages/domain/src/design.ts`, `geometry.ts`, `performance.ts`, `index.ts`；擴充 `packages/protocol/src/events.ts` 的所有形狀投影，避免只改其中一份 enum。

custom 分支採 `outline: { version: 1, vertices: {x:number,y:number}[], mirror: 'none'|'leftRight'|'topBottom'|4|6|8|12 }`。vertices 為旋轉前毫米座標；diameterMm 與最大半徑一致，變更尺寸由編輯器同步縮放座標。基本形狀無 outline；拒絕 custom 缺輪廓。保留 layerSchema 為可供現有 extend/pick 使用的 object，跨欄位 refine 確認不會被 pick 漏掉。

- [ ] 先寫 design／geometry／mass／performance 測試，確認目前拒絕 custom。
- [ ] `makeLayerVertices` 對 custom 驗證後旋轉真實輪廓，不做徑向重採樣。既有四種造型保持原結果。
- [ ] 現有 neck 計算稽核所有徑向假設；custom 使用真實線段距離，不能只按角度排序。custom 的 roundness 不接受任意提高分數的客戶端宣告；採幾何推導或保守固定值，使用獨立模型版本並保留舊版結果。
- [ ] 測試含孔凹形面積、質心、慣量解析例子，錯誤訊息具體。後端重算結果與前台一致。
- [ ] 協定測試對戰視覺及教師投影 custom roundtrip，明確版本／能力不符提示。
- [ ] 執行 domain、protocol 全測試與根目錄 `pnpm typecheck`，審查並 commit。

## 任務 3：資料庫、紀錄及人氣設計

修改 `packages/db/src/schema.ts`, `persistence.ts`, `apps/server/src/records/design-repository.ts`, `apps/server/src/battle/engine.ts`，增加下一個順序的 additive SQL migration 及配套 journal（遵循既有 migration 工具）。

- [ ] DB roundtrip 測試先失敗：一份三層混合設計存入、讀出仍保留完整 outline。
- [ ] 新增 custom enum 與 nullable JSONB outline 欄位；檢查既有 SQL triggers／約束，不破壞 draft→activate 流程。舊列保持 null。
- [ ] persistence、load、snapshot、battle visual DTO 全部保留輪廓；儲存前重新驗證。
- [ ] 人氣 fingerprint 納入 canonicalizeOutline 結果，不同形狀不合併，同形起點／順逆差異可合併；不得混淆有意旋轉與尺寸差異。
- [ ] 在隔離測試 DB 驗證 migration、新舊混用及還原；不使用生產資料測試。單元及 PostgreSQL 測試通過後兩階段審查與 commit。

## 任務 4：畫布及設計室

新增 `apps/web/src/features/designer/CustomOutlineEditor.tsx`、`customOutlineDraft.ts` 及測試；修改 `LayerControls.tsx`, `useDesigner.ts`, `DesignerPage.tsx` 與必要局部 CSS。

- [ ] reducer 先測草稿／已套用隔離、undo/redo、取消、類別切換保留草稿；只有有效套用修改 TopDesign。
- [ ] SVG viewBox -44 -44 88 88，以 pointer capture 支援 mouse/touch/pen；用畫布矩陣轉換毫米座標，stroke 只存有限數值。畫布外不阻止頁面滑動。
- [ ] 基礎／自定 tabs 保留既有參數工具。鏡像選單 none／左右／上下／4／6／8／12；半側或扇區內畫外邊界，端點顯示吸附到參考線，預覽完整反射結果。
- [ ] raw stroke 與套用用的最多 256 點輪廓分離。可預覽簡化／平滑，禁止 silent truncation；顯示錯誤並保留最後有效設計。
- [ ] 以 pointerup 或限頻更新幾何；按套用才重建計算與 3D。縮放及旋轉不自動置中。
- [ ] 前端單元測試及 1440/1024/390 寬度 E2E，包含 touch 事件、錯誤修復及原有 compact 頁面；審查與 commit。

## 任務 5：教師統計與 Excel

修改 `apps/server/src/analytics/parameters.ts`, `parameter-usage.ts`, `usage.ts`, `admin/records-routes.ts`, `exports/workbook.ts` 及 `apps/web/src/features/admin` 相關呈現。

- [ ] SQL／workbook fixtures 新增 custom，先確認現有 sides/lobes 邏輯錯誤。
- [ ] 按層新增基礎／自定維度及 mirror 編輯方式；custom points 欄位 null／不適用。共同數值保持可比較，無鏡像的份數 null。
- [ ] 設計紀錄保留完整輪廓及縮圖；Excel 用設計 ID 關聯，列出類別、鏡像及共同指標，不輸出龐大座標到一般數值欄。
- [ ] 高分紀錄帶樣本數與模型版本，文案為歷史高分，不宣稱最佳解。日週月使用量定義不變。
- [ ] 新舊 mixed fixtures 的 SQL integration／Excel／教師 UI 全測試，審查及 commit。

## 任務 6：匯出、全鏈路及發佈

測試／必要修正 `exportBoardsStl.ts`, `preview3DGeometry.ts`, 對戰視覺組件、`tests/handoff/shapecut.spec.ts`, `tests/e2e`。

- [ ] 不對稱凹形輸出三層 6mm STL：檢查 bounding box、體積、封閉 manifold 與 normals；畫面／輸出點集相符。
- [ ] ShapeCut 真實接收與切片測試，沿用 token/window/origin 防護。未驗收 receiver 之前不得宣稱可用。
- [ ] 完整 30 秒人機及雙人 round，房間、準備、判定、結算、返回房間及再次準備；跨瀏覽器重現輪廓。
- [ ] 執行 `pnpm typecheck`, `pnpm build`, 全部非生產單元／整合測試和相關 E2E。實體 iPad 未有證據則明確列為待實機測試。
- [ ] 全體規格／品質審查及確認工作樹狀態。先備份，部署 additive DB／相容後端，再部署前端入口。發佈前確認實際登入與權限，不能把舊登入記錄當現時可部署證據。
- [ ] 核實部署 SHA、公開 custom roundtrip／對戰／ShapeCut；記錄實際通過與未完成項目，停止任何失敗版本擴散。
