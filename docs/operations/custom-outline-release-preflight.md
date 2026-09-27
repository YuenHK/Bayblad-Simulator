# 自定造型發佈前檢查

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

- `e321959` 全部非生產單元／整合測試通過：domain 191、protocol 99、web 198、DB 21、server 519、integration/CI 211；另有 32 skipped，不算已驗證。
- 教師 Chromium E2E 兩項通過：登入、管理確認、Excel 下載、篩選、高分輪廓及刪除後清除、iPad 尺寸鍵盤與減少動態效果。已查看測試輸出的高分列表截圖；未在實體 iPad 操作。
- 高分設計孔位補正 `6506fd2` 的針對 UI 10、protocol 2 tests 及 build 已通過；全 CI 仍須以最新 commit 核實。
- 先前 custom 人機案例已驗證完整每輪 30 秒。2026-09-28 再以 `CINEMATIC_BATTLES=1 E2E_WEB_PORT=4182 E2E_REALTIME_PORT=4183 E2E_ADMIN_PORT=4184 pnpm test:e2e tests/e2e/cinematic.spec.ts --grep 'two guests'` 通過双人完整長播（約 1.6 分鐘）：兩個獨立訪客，自定對基本，雙方不按判定均 Miss、每輪 result 為 30000ms、召喚／決勝／結算、返回同房再準備，零 pageerror。三角色快速引擎測試另證明讓位／觀戰及判定私隱，不混作長播證據。
- `6506fd2` PostgreSQL CI `36331356101` 完整 success；含新增高分設計分組、雙方同設計的樣本／觀測分別計數、版本分組、篩選、分頁、輪廓與孔位欄位。後續 `d4e7fff` 修復高分查詢錯誤訊息被一般查詢清除的問題，UI 11 tests 通過及品質複查通過；最新整體 CI 須再核實。

自管 Compose 的 protected-host 發佈工具不是 Render 的既有部署路徑，不能把其 CI fixture 當成正式站備份或部署證據。
