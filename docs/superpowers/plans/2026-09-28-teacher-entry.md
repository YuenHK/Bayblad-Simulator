# 教師入口與平台控制精簡

使用者已明確要求兩項修改，依其清晰任務自動完成指示直接執行。保留字體、字號、顏色、房間管理、驗證機制及學生資料；不修改正式平台狀態或歷史命令。

## 設計與實作

- [x] `RoomsPanel.tsx` 移除暫停／恢復按鈕及 paused prop，`AdminDashboard.tsx` 同步呼叫。
- [x] `dashboard-routes.ts` 的 actionSchema 僅接受 room.close／room.remove；平台暫停指令回 400，不能提交新平台控制操作。保留歷史命令型別與重播相容，無 DB migration。
- [x] `App.tsx` 頁尾新增相同 panel 的「教師後台」，連到既有 `https://bayblad-simulator-api.onrender.com/admin/`，新分頁及 noopener noreferrer；不把口令放入連結。
- [x] 先新增測試：頁尾三連結並列、教師無暫停／恢復控制、合法 session+CSRF 的 pause true/false 均拒絕且平台狀態不變；看到紅燈後實作。原確認對話測試改以房間操作覆蓋，不刪除安全斷言。
- [x] 執行相關單元、完整測試、typecheck、lint、build、教師 E2E。檢視 diff 後推驗證分支；CI 綠燈後部署指定 SHA，再核實公開教師／學生頁。

## 驗收

`pnpm --filter @steam-top/server exec vitest run src/admin/dashboard-routes.test.ts`

`pnpm --filter @steam-top/web exec vitest run src/App.test.tsx src/features/admin/AdminDashboard.test.tsx`

教師 E2E 改驗證不存在暫停／恢復按鈕，房間關閉／移除仍保留兩步確認及鍵盤 Escape 焦點復原。頁尾沿用 auto-fit grid，無需 CSS 改動。

## 本機驗證 2026-09-28

已觀察新增前端及 API 測試紅燈，再完成實作。相關 API 6/6、UI 14/14；完整 `pnpm test` 重跑成功（domain 191、protocol 101、web 204、db 21、server 524、整合 212，32 項特定環境略過）；typecheck、lint、build 通過。首次與瀏覽器並行的效能測試得到 100.5ms 超過 100ms，移除並行負載後完整重跑通過，未修改測試上限。

教師 E2E 5/5、頁尾桌面／手機 E2E 2/2 通過，已檢視 1440px／390px 截圖。只讀獨立審查無 Critical／Important／Minor；未修改 CSS、登入機制、資料庫或學生資料。下一步驗證分支 CI，通過後正式部署及公開頁面驗收。

## 部署接續點

最終驗收（2026-09-28）：GitHub Pages `36379232041` success，公開前後端均部署功能提交 `1a238b6ec81bd5d1578629345975b8fb44c3c5d9`。公開學生測試 **4/4 passed（55.6 秒）**；連同下述教師測試合共 8/8 通過。涵蓋 Chromium、Firefox、WebKit iPad 模擬及 Chromium 手機模擬，未聲稱實體 iPad 驗收。Chrome 實際檢視公開頁尾三張卡並列、已連線狀態，以及點擊「進入教師後台」成功在新分頁開啟正確 `/admin/` 網址，原主頁保留。全部本次要求完成；以下保留部署過程紀錄。

最新（2026-09-28 12:47 HKT）：Chrome 已恢復；`36378076779` quality／production-security 與 PG `36378076732` 全部 success，均為 `1a238b6`。Render 指定部署 `dep-dasv1dbbc2fs73agr5hg` 於 12:45:59 Live，公開資產 `index-C3oCIhIb.js` 與建置一致，ready/database/migration 均正常。公開教師四瀏覽器測試 **4/4 passed（56.6 秒）**，涵蓋暫停／恢復控制不存在及其餘教師功能正常。已 fast-forward 推同一功能提交至 main，等待 Pages 與主頁公开驗收。沒有修改平台狀態或學生資料。

以下為先前連線阻擋紀錄，已解除：

程式提交 `1a238b6ec81bd5d1578629345975b8fb44c3c5d9` 已推 `codex/teacher-entry-validation`，尚未推 main。PostgreSQL `36378076732` success；品質流程 `36378076779` 最後核實仍在 `pnpm test:e2e`，須讀取最終結果及後續安全 job。

Render 曾開啟指定提交搜尋視窗，但未按 Deploy Commit。Chrome 控制逾時後連線消失：瀏覽器清單只剩內置瀏覽器，原 Chrome ID 2 不可用。沒有切換登入方式、讀取憑證或繞過控制限制。待使用者重新連接 Chrome，先核實 CI 完整通過，部署指定提交並驗收教師端無平台控制，再推 main／核實 Pages 及公開頁尾新連結。正式網站仍為前一版本，不能宣稱本次已上線。
