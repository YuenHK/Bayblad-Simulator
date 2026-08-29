# 發佈與回復手冊

## 發佈前關卡

1. 只發佈 CI `quality` 及 `production-security` 全部通過的 commit。記錄 commit SHA、前一版本及本次三個應用映像的 `repository@sha256:...`；不可使用 floating tag 作為回復根據。
2. 停止會寫入資料庫的發佈工作，按 [`infra/backup/README.md`](../../infra/backup/README.md) 設定受限的 `PGSERVICE`、`PGPASSFILE`、`BACKUP_DIR`、`AGE_RECIPIENT` 及簽署鍵，執行 `./infra/backup/backup.sh`。備份必須是含簽署 manifest 的 age 加密 `dump.age`，並另存於受控位置。立即在隔離 PostgreSQL 實例執行 `./infra/backup/restore.sh <完整備份目錄>` 還原演練，核對 backup manifest、migration ledger 及記錄數量；未能還原的備份不算可用。
3. 核對正式環境 secret 沒有寫入 Git、image 或日誌，再用 `scripts/validate-deployment-env.mjs` 驗證 HTTPS origin 及映像 digest。

## 發佈

1. 先拉取並核對已記錄 digest 的映像。
2. Compose 的 `migration` 是唯一 migration owner：它執行 `migrate-and-start.sh --migrate-only`，由應用 migration runner 取得 PostgreSQL advisory lock，在同一 transaction 核對 SQL SHA-256 與 `app_schema_migrations` ledger。失敗時非零離開，server 因 `service_completed_successfully` 依賴而不會啟動。
3. 執行 `docker compose up -d --wait`。不可手動繞過 migration 容器、修改 ledger，或在 migration 失敗後強行啟動新 server。
4. 記錄實際應用映像 digest 及 migration outcome。

## Smoke test

通過公開 HTTPS origin 檢查：HTTP 轉 HTTPS、`/health/ready` 為 200、首頁及 3D 預覽可載入、兩個測試身份可開房／入房／WebSocket 對戰、教師可登入及查看剛建立的記錄。再執行不可 skip 的 `pnpm test:security`。任一項失敗就停止發佈並保留證據。

## 回復判斷

- **向後相容 migration**：若上一版程式已在還原演練中證明可讀寫現有 schema，可把 Compose 映像精確改回已記錄的上一個 digest，重新啟動後重跑 smoke test。
- **不相容或未證明相容**：先停止所有寫入，保留當前資料庫的加密事故備份；在新的空白資料庫及新 volume 還原發佈前已驗證備份，再部署上一個映像 digest。不可以手寫反向 SQL 取代已演練的還原。

回復後重跑全部 smoke test，核對 migration ledger、restore target ID、刪除 ledger 及對戰記錄。保留時間、執行人、原因、前後 digest、備份 manifest 與驗證結果。
