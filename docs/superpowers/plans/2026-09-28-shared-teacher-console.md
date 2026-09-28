# 共用教師控制台實作計劃

> 使用 executing-plans 在本對話逐項執行。沿用使用者指定的工作目錄及 codex/shapecut-handoff 分支，不更動過期 adc8 checkout。使用者已批准自動完成及部署，不另設逐步確認。

**目標：** 共用口令、非破壞性教師控制台、四頁籤及歷史靜態 3D。
**架構：** 正式 auth composition 啟用 sharedAccess；既有持久 session／CSRF 繼續使用。歷史 projection 擴充顏色及排行榜代表設計；SVG 靜態立體縮圖共用建模函數。
**技術棧：** TypeScript、Fastify、PostgreSQL、React、Three.js、Vitest、Playwright。

## 2026-09-28 本機實作與驗收紀錄

### 最新檢查點：公開部署及教師／學生驗收完成

- 使用者已明確回覆「確認公開部署」，共用存取部署授權已解除，不需再次詢問。
- 2026-09-28 12:02 HKT：Render `dep-dasuc3npn0mc73a41pg0` 標示 `0435c9d` Live，建置產物為 `index-D3gwp0Bp.js`；但公開 `/admin/` 實際仍回傳 `index-FuFJ4NX8.js`，新資產 404，單一口令登入 HTTP 400。公開教師測試第一項失敗於仍顯示舊帳密介面，已停止其餘測試；不能宣稱新版本驗收成功。
- 12:05 重新啟動已記錄於 Render Events；其後短暫 suspend/resume 已恢復服務，仍回傳舊版本。未刪資料、未變更環境憑證、未推 main。
- 第二次指定部署 `dep-dasug9bbc2fs73aeec10` 於 12:08:58 HKT Live，公开 `/admin/` 已回傳 `index-D3gwp0Bp.js`／`index-YRWdMXh2.css`，ready/database/migration 均正常，版本不一致已解除。未確認供應商內部根因，不推斷是應用程式錯誤。
- 正式教師測試 Chromium 桌面、Firefox 桌面、WebKit iPad 模擬、Chromium 手機模擬 **4/4 passed（1.0 分鐘）**：錯誤口令、共用登入、四頁籤、三類歷史靜態 3D、無改密碼及刪除按鈕、登出、空日期範圍六工作表 Excel 均通過。沒有匯出學生內容或刪資料。
- `0435c9d` 已 fast-forward 推送 main；Pages `36376599095` build/deploy 全部 success。發佈後學生設計／限制／3D 預覽／響應式四個瀏覽器項目 **4/4 passed（50.3 秒）**。實體 iPad／雷射試切不在此公開軟件驗收證據內。
- 收尾例外：嘗試停用原 `automation` 未成功；工具 view 只回傳渲染卡片，update 要求 name/prompt/rrule 完整原設定，但本機 automations 目錄沒有此設定檔。沒有捏造排程或建立重複任務，不可宣稱已停用。功能及公開部署均已完成，後續 heartbeat 不應重做部署；只需處理原排程停用。
- 公開登入截圖（忽略於 Git）：`test-results-public-shared-console/shared-login-public.png`。

以下為先前驗證紀錄，部署前等待確認狀態已被上述最新檢查點取代。

- 已提交並推送 `codex/shared-teacher-console-validation`：`0435c9dafe9e8dcc9cec0af71cf1f2dc6a577b9e`。
- 完整本機測試通過：domain 191、protocol 101、web 203、db 21、server 523、integration/CI 212；32 個需特定環境的案例本機略過。typecheck、lint、build 通過。
- GitHub Actions `36373977929` 的 quality 與 production-security 全部 success；真 PostgreSQL workflow `36373977812` success。
- 共用存取的風險已獲使用者在部署前明確確認：知道網址及口令的人能查看及匯出既有學生資料。已完成正式部署及上述公開教師測試。

- 工作 1–3 已實作：共用口令、停用改密碼與永久刪除端點、歷史完整幾何／顏色、篩選後的最高分設計、四頁籤、懶載入靜態 SVG 立體縮圖。沒有資料庫結構變更或刪除學生資料。
- 新增 auth、protocol、歷史 projection、靜態幾何及 UI 回歸測試，先觀察失敗再實作；原有 session／CSRF／限流／來源檢查保留。
- `pnpm typecheck`、`pnpm lint`、`pnpm build` 通過。Playwright admin 5/5 通過（33.9 秒）；1440px／390px 四區截圖已檢查，頁面無水平溢出，篩選預設折疊。
- 獨立程式審查指出兩處 CI smoke 登入 payload 及公開測試匯出後日期未還原，均已修正；新增 CI payload 回歸。安全 writer 校驗只更新已審核的兩個工作雜湊，權限／授權守衛／互斥鎖未改。
- 全套回歸、真 PostgreSQL、CI、正式 Render 部署及公開教師驗收均已完成；Pages 收尾狀態見頂部最新檢查點。

以下保留原始逐項驗收清單；最終勾選以完整 CI 與公開驗收證據為準。

## 1. 共用入口
- [ ] 在 apps/server/src/auth/shared-access.test.ts 寫 Fastify 行為測試：POST /api/admin/login `{passphrase:'admin'}` 得 204，錯口令 401，舊 username/password payload 400，跨來源 403，cookie + session 正常，DELETE／deletion-preview／password 不可用。
- [ ] 執行 `pnpm --filter @steam-top/server exec vitest run src/auth/shared-access.test.ts` 觀察紅燈。
- [ ] 修改 auth/admin-auth.ts、auth/composition.ts、admin/delete-records.ts：獨立內部身份、限流及 session 建立，sharedAccess 停用密碼及刪除路由；舊資料不動。
- [ ] 重跑新測試及 auth/admin-auth.test.ts；提交。

## 2. 歷史設計資料
- [ ] 擴充 packages/protocol/src/events.ts 的歷史 layer 可選 color，排行榜代表設計（design、matchId、occurredAt、score）。先加 protocol/SQL regression 觀察失敗。
- [ ] 修改 apps/server/src/admin/records-routes.ts：完整共用設計 projection，row_number 或 distinct on 按 total_score desc、時間 desc、matchId、slot 擇代表；先套所有篩選再排名，不能只取當頁紀錄。
- [ ] 在 admin/leaderboard.postgres.test.ts 驗證同學生多設計、同分、日期篩選與 basic/custom；保留舊歷史相容。提交。

## 3. 靜態預覽及頁籤
- [ ] 新增 apps/web/src/features/admin/StaticDesignPreview.test.tsx，使用真建模幾何驗證基本／custom／孔洞／缺少裝配資料；觀察紅燈後實作 StaticDesignPreview.tsx。
- [ ] AdminLogin.tsx 改單一口令與共用提示；AdminDashboard.tsx 移除密碼及刪除 state/dialog，四頁籤（role=tab/tablist/tabpanel），共用日期／文字篩選；RecordsTable.tsx 移除刪除選取欄。
- [ ] RecordsTable.tsx、LeaderboardTable.tsx、HighScoringDesigns.tsx 加靜態縮圖，參數折疊，高分卡片；排行榜可查看該身份歷史紀錄。
- [ ] 新增頁籤／口令／預覽測試後執行 `pnpm --filter @steam-top/web test`。更新舊測試使其符合已批准規格，保留 auth 安全斷言。

## 4. 完整驗收與部署
- [ ] `pnpm test`、`pnpm typecheck`、`pnpm build`；真 PostgreSQL CI。
- [ ] 更新 tests/e2e/admin.spec.ts 及本機 fixture，驗證桌面1440與手機390頁籤、preview、篩選、匯出，檢視截圖；移除舊 password UI E2E，保留停用端點覆蓋。
- [ ] 檢視 diff 和安全範圍；測試全綠才推 main／Render 部署，核對 SHA、ready、公開 login + 四區 + Excel。
- [ ] 記錄驗收證據，若全部舊自定造型公開 gate 同時完成則停用原 automation；有阻擋如實記錄，不部署半成品。
