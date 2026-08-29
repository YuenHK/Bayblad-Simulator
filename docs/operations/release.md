# 發佈與回復手冊

## 發佈前關卡

1. 只發佈 CI `quality` 及 `production-security` 全部通過的 commit。`release-images` 會推送映像並產生 GitHub artifact attestation。CI 的 checksum 命令是 `./scripts/portable-sha256.sh manifest .release server.json web.json database.json release-manifest.json > .release/SHA256SUMS`，所有項目必須是 basename。另外從 CI run 記錄 manifest SHA-256、repository 及 commit；同目錄 `SHA256SUMS` 不構成獨立授權。
2. 停止會寫入資料庫的發佈工作，按 [`infra/backup/README.md`](../../infra/backup/README.md) 設定受限的 `PGSERVICE`、`PGPASSFILE`、`BACKUP_DIR`、`AGE_RECIPIENT` 及簽署鍵，執行 `./infra/backup/backup.sh`。備份必須是含簽署 manifest 的 age 加密 `dump.age`，並另存於受控位置。立即在隔離 PostgreSQL 實例執行 `./infra/backup/restore.sh <完整備份目錄>` 還原演練，核對 backup manifest、migration ledger 及記錄數量；未能還原的備份不算可用。
3. 核對正式環境 secret 沒有寫入 Git、image 或日誌，再用 `scripts/validate-deployment-env.mjs` 驗證 HTTPS origin 及映像 digest。

## 發佈

1. 從已驗證 artifact 讀取 `images.server`、`images.web` 及 `images.database`，分別寫入受限 env file 的 `SERVER_IMAGE`、`WEB_IMAGE`、`DATABASE_IMAGE`。`images.migration` 必須與 `images.server` 完全相同。
2. Compose 的 `migration` 是唯一 migration owner：它執行 `migrate-and-start.sh --migrate-only`，由應用 migration runner 取得 PostgreSQL advisory lock，在同一 transaction 核對 SQL SHA-256 與 `app_schema_migrations` ledger。失敗時非零離開，server 因 `service_completed_successfully` 依賴而不會啟動。
3. 唯一受支援的入口是 `sudo ./scripts/deploy-production.sh <artifact絕對目錄> <root擁有的0600 env> <CI外部manifest SHA256> <owner/repo> <40位commit>`。它驗證外部 digest、`gh attestation verify --repo`、repository/commit 綁定，只解析 env 一次並使用 private canonical snapshot，再依次執行 Compose config、pull 及 up。直接執行 `docker compose` 不受支援。
4. 記錄實際應用映像 digest、release manifest digest 及 migration outcome。正式 `compose.yaml` 不含 build，因此不會把 local mutable tag 當成發佈物；`compose.build.yaml` 只供 CI 生產測試。

## Smoke test

通過公開 HTTPS origin 檢查：HTTP 轉 HTTPS、`/health/ready` 為 200、首頁及 3D 預覽可載入、兩個測試身份可開房／入房／WebSocket 對戰、教師可登入及查看剛建立的記錄。再執行不可 skip 的 `pnpm test:security`。任一項失敗就停止發佈並保留證據。

## 回復判斷

- **向後相容 migration**：`prepare-application-rollback.sh` 只生成候選 rollback manifest，只回退 server/web 並保留現行 database image。候選 manifest 必須送回受保護的 release CI，綁定 rollback 審批記錄、repository 及 commit 產生新 attestation 與外部 SHA-256；未授權的本地候選物不可部署。

如必須回退 database engine，需在獨立變更中證明 engine major、data-directory format、extension 和 `pg_upgrade`/還原路徑相容，並以新 volume 演練。本 wrapper 沒有收到這份相容證據時必須拒絕 database engine rollback。
- **不相容或未證明相容**：先停止所有寫入及所有應用容器，保留當前資料庫的加密事故備份。執行 `./infra/backup/verify-rollback-preflight.sh <發佈前備份> <現行外部刪除 ledger>`。若 ledger 的行數或 hash 已前進，**禁止資料庫回復**：舊備份不能重放已審計刪除，回復會導致已刪資料復活；保持平台停止並以 forward-fix migration 處理。

只有 preflight 證明外部 tombstone ledger 未前進，才可在全新隔離 PostgreSQL/volume 還原。設定 `PROMOTE_PGSERVICE`、`PROMOTE_APP_ROLE`、`PROMOTE_CONFIRM_DATABASE`、`RESTORE_ALLOWED_TARGET_ID`及其他簽署驗證變數後執行 promotion。它會在 advisory-lock transaction 內撤銷 CONNECT、終止其他 session，再核對 marker 與 deletion rows 及推進 production marker。只在 DATABASE_URL cutover 完成後，DBA 才可明確執行 `GRANT CONNECT ON DATABASE ... TO <PROMOTE_APP_ROLE>`。

回復後重跑全部 smoke test，核對 migration ledger、restore target ID、刪除 ledger 及對戰記錄。保留時間、執行人、原因、前後 digest、備份 manifest 與驗證結果。
