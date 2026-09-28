# 自定造型發佈前檢查

## 2026-09-28 11:02 最新交接

- 正式後端已更新785cb5d：Render `dep-daste5vpn0mc739vtpt0` Deploy succeeded / Live，全部 migration already-applied，readiness ready/database ok/migration ok。GitHub main=785cb5d；Pages36371787616 success，前台程式內容與c8b4950相同（修正只在後端儲存驗證）。
- 以 `CINEMATIC_BATTLES=1 pnpm exec playwright test --config playwright.cinematic-public.config.ts --grep 'two guests|custom computer' --output test-results-public-fixed-cinematic` 重跑公開網站：**2/2 passed，4.4分鐘**。自定對基本雙人2.3分鐘、人機2.1分鐘，完整30秒回合、Miss最低力、召喚／決勝、結算及返回同房再準備。已查看實際神獸演出截圖。
- 前述結算驗證錯誤已由回歸、PG CI及公开完整對戰共同證明修復。首次失敗測試紀錄及原有學生資料均保留，沒有刪除或偽造完成紀錄。
- **唯一登入阻擋：** 公開教師頁仍需使用者登入。Chrome 已保留 `https://bayblad-simulator-api.onrender.com/admin/`，使用者不需把密碼傳給代理。登入後才能做正式高分縮圖／篩選／統計／Excel驗收；本機教師2項E2E及PG已通過不能替代此公開驗收。
- 不需重做已通過的Neon備份、遷移、學生畫布8項、ShapeCut3項、公開完整雙人／人機。沒有新登入通知或新失敗時保持安靜，勿反覆嘗試同一登入。所有公開驗收完成後才停用automation；實體iPad與雷射試切仍屬硬件驗收邊界。

## 2026-09-28 10:43 公開驗收與修正

- 後續核實：785cb5d 品質／安全 CI36370870991、PostgreSQL CI36370870996 均完整 success；已提交 Render 修正版部署，仍須公開長播重驗。人機 observer 測試本機通過（1.7分鐘）；公開基本ShapeCut桌面1280／手機390兩項亦通過。教師端仍停在登入頁。

- Render c8b4950 已確認 Deploy succeeded / Live；0005、0006 migration applied，其餘 already-applied。readiness 為 ready/database ok/migration ok。正式庫只讀核對仍為 51 matches、291 design_layers，outline 欄位存在。
- GitHub main 已 fast-forward 至 c8b4950；Pages run36370225083 build/deploy success。公開 Chrome 已見自定造型／鏡射並成功連線。
- 公開畫布驗收 8/8 通過：左右、上下、4/6/8/12 鏡射及 per-layer 草稿、1440px 滑鼠／390px 模擬觸控。公開自定凹形 STL 實際下載 → ShapeCut 接收 → 6mm 材料 → 3 切片／ZIP 連結，1/1 通過，已查看結果截圖；不是實體試切。
- 公開雙人對戰動畫後結算未出現；Render 同時間三次 ZodError。已以相同 custom/basic 真實重量重現 completedMatchRecordSchema 的 challenge score 驗證失敗：scorer 採 1mg 量化，validator 卻採原始差值。修正共用 challengePoints，保留嚴格容差和篡改拒絕；含 swapped 案例及新增 PostgreSQL basic/custom 完成／重試 fixture。修正版785cb5d只推驗證分支，待 CI，再部署重驗。測試建立的失敗紀錄沒有刪除。
- 人機長播測試會錯過短暫粉碎視窗，已改頁內 observer 驗證 result=30000ms、明確勝方及對應碎裂／平手；需重跑確認，不以測試修改代表功能通過。
- 完整 pnpm test exit0：domain191、protocol100、web199、db21、server521、integration/CI211，32skip；typecheck exit0。獨立修正審查無重要問題。
- 公開教師端需要登入，已保留 Chrome 登入頁並通知使用者；沒有取用或重設密碼。登入後仍須驗收教師高分縮圖、統計與 Excel。

## 2026-09-28 10:30 更新（部署進行中）

- 使用者已登入 Neon；已核實 `bayblad-simulator` 的 production 分支、Singapore、Free plan，history retention 為 6 小時。
- 已於 10:28 建立同專案的 `pre-custom-outline-20260928` 資料與 schema 備份分支，來源 production，Expires=Never。這是部署前分支副本，不是已完成還原演練，亦不會涵蓋建立後的新寫入；未刪除或覆寫正式資料。
- Render Auto-Deploy=Off，指定 commit 功能支援任意分支。重新核實 c8b4950 的品質 CI36331707681、PostgreSQL CI36331707693 皆 success。
- 部署前公開 readiness 為 ready/database ok/migration ok，學生大廳成功連線並顯示沒有房間。
- 10:30 已手動提交 c8b4950 後端部署 `dep-dast2h7pn0mc739uc2pg`，初始狀態 Building。尚未宣稱部署成功；GitHub main／Pages 未更新，待後端結果通過才更新。
- 備份分支 SQL 只讀驗證成功：51 場 matches、291 列 design_layers，outline 欄位仍不存在，符合遷移前版本；沒有讀出個別學生資料。10:31 Render Docker build 已完成，進入 Deploying，仍待啟動／readiness。

## 2026-09-27 現況（只讀核實，未部署）

- GitHub `main`：`eb67049289cded879ad9dcc71d062b69324a2a82`。
- Render `bayblad-simulator-api`，Service ID `srv-daadqdp42hec73a7pv40`：Docker Free，Singapore，追蹤 `main`。
- Render 顯示最後成功部署 `c965b4eedf7de98af4d551810294207159971c5f`。前後端版本不應只憑分支名稱判定一致。
- Dockerfile：`./Dockerfile.server`；build context：`.`；Docker Command：`./scripts/migrate-and-start.sh`；health check：`/health/ready`。
- 公開 readiness 首次 20 秒超時，稍後回傳 `status=ready,database=ok,migration=ok`，符合閒置喚醒現象；不是新功能驗收。
- Render 已以既有 GitHub 登入成功。資料庫供應商為 Neon；Neon 控制台停在登入頁，尚未核實備份／可還原點。未登入 Neon、未建立或修改備份、未執行正式遷移。

## 發佈前仍需完成

1. 完成歷史高分設計及全部規格／品質審查，確認最新 CI 和 PostgreSQL fixture 結果。
2. 使用者登入 Neon，核實可恢復的備份／還原點與保留限制；記錄證據，不將資料庫 URL、密碼或學生資料寫入 Git。
3. 確認 Render 自動部署模式及手動指定 commit 的方式；先做好維護／房間排空及備份，再按相容順序發佈。不要只推 `main` 同時觸發兩端、忽略資料庫前置條件。
4. 後端啟動命令會先執行遷移，故未備份前不能啟動新版本。舊前端不宣告 `customOutlineVersion:1`，新後端會提示重新整理；需協調 Pages 更新時間。
5. 驗證公開前後端 SHA、自定輪廓儲存與回讀、教師高分縮圖／匯出、完整 30 秒人機與雙人流程、ShapeCut 接收。實體 iPad／試切未完成不可宣稱已驗收。

## 本機驗收邊界

- 2026-09-28 00:47 核實：功能／測試版本 `c8b4950` 品質 CI `36331707681`、PostgreSQL CI `36331707693` 完整 success。以下較早「待核實」狀態已由此更新；這不包含正式備份、部署或公開驗收。Neon 登入阻擋未解除，不重試同一登入。

- `e321959` 全部非生產單元／整合測試通過：domain 191、protocol 99、web 198、DB 21、server 519、integration/CI 211；另有 32 skipped，不算已驗證。
- 教師 Chromium E2E 兩項通過：登入、管理確認、Excel 下載、篩選、高分輪廓及刪除後清除、iPad 尺寸鍵盤與減少動態效果。已查看測試輸出的高分列表截圖；未在實體 iPad 操作。
- 高分設計孔位補正 `6506fd2` 的針對 UI 10、protocol 2 tests 及 build 已通過；全 CI 仍須以最新 commit 核實。
- 先前 custom 人機案例已驗證完整每輪 30 秒。2026-09-28 再以 `CINEMATIC_BATTLES=1 E2E_WEB_PORT=4182 E2E_REALTIME_PORT=4183 E2E_ADMIN_PORT=4184 pnpm test:e2e tests/e2e/cinematic.spec.ts --grep 'two guests'` 通過双人完整長播（約 1.6 分鐘）：兩個獨立訪客，自定對基本，雙方不按判定均 Miss、每輪 result 為 30000ms、召喚／決勝／結算、返回同房再準備，零 pageerror。三角色快速引擎測試另證明讓位／觀戰及判定私隱，不混作長播證據。
- `6506fd2` PostgreSQL CI `36331356101` 完整 success；含新增高分設計分組、雙方同設計的樣本／觀測分別計數、版本分組、篩選、分頁、輪廓與孔位欄位。後續 `d4e7fff` 修復高分查詢錯誤訊息被一般查詢清除的問題，UI 11 tests 通過及品質複查通過；最新整體 CI 須再核實。

自管 Compose 的 protected-host 發佈工具不是 Render 的既有部署路徑，不能把其 CI fixture 當成正式站備份或部署證據。
