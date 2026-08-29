# 發佈與回復手冊

## 發佈前關卡

1. 只發佈 CI `quality` 及 `production-security` 全部通過的 commit。建立 `v*` tag 後，`release-images` job 會以已審核的 base-image digest 建立 server、web 及 database 映像，連 SBOM/provenance 推送至 GHCR，並輸出不可變的 `release-manifest-<commit>` artifact。下載 artifact，執行 `sha256sum -c SHA256SUMS`，並把 `release-manifest.json` 、commit SHA 及 artifact digest 一併歸檔；不可使用 floating tag 作為發佈或回復根據。
2. 停止會寫入資料庫的發佈工作，按 [`infra/backup/README.md`](../../infra/backup/README.md) 設定受限的 `PGSERVICE`、`PGPASSFILE`、`BACKUP_DIR`、`AGE_RECIPIENT` 及簽署鍵，執行 `./infra/backup/backup.sh`。備份必須是含簽署 manifest 的 age 加密 `dump.age`，並另存於受控位置。立即在隔離 PostgreSQL 實例執行 `./infra/backup/restore.sh <完整備份目錄>` 還原演練，核對 backup manifest、migration ledger 及記錄數量；未能還原的備份不算可用。
3. 核對正式環境 secret 沒有寫入 Git、image 或日誌，再用 `scripts/validate-deployment-env.mjs` 驗證 HTTPS origin 及映像 digest。

## 發佈

1. 從已驗證 artifact 讀取 `images.server`、`images.web` 及 `images.database`，分別設為 `SERVER_IMAGE`、`WEB_IMAGE`、`DATABASE_IMAGE`。`images.migration` 必須與 `images.server` 完全相同。執行 `docker compose pull`，再用 `docker image inspect` 核對拉取後 RepoDigest。
2. Compose 的 `migration` 是唯一 migration owner：它執行 `migrate-and-start.sh --migrate-only`，由應用 migration runner 取得 PostgreSQL advisory lock，在同一 transaction 核對 SQL SHA-256 與 `app_schema_migrations` ledger。失敗時非零離開，server 因 `service_completed_successfully` 依賴而不會啟動。
3. 執行 `docker compose up -d --wait`。不可手動繞過 migration 容器、修改 ledger，或在 migration 失敗後強行啟動新 server。
4. 記錄實際應用映像 digest、release manifest digest 及 migration outcome。正式 `compose.yaml` 不含 build，因此不會把 local mutable tag 當成發佈物；`compose.build.yaml` 只供 CI 生產測試。

## Smoke test

通過公開 HTTPS origin 檢查：HTTP 轉 HTTPS、`/health/ready` 為 200、首頁及 3D 預覽可載入、兩個測試身份可開房／入房／WebSocket 對戰、教師可登入及查看剛建立的記錄。再執行不可 skip 的 `pnpm test:security`。任一項失敗就停止發佈並保留證據。

## 回復判斷

- **向後相容 migration**：若上一版程式已在還原演練中證明可讀寫現有 schema，從上一個已驗證 release manifest 把 `SERVER_IMAGE`、`WEB_IMAGE`、`DATABASE_IMAGE` 改回精確 digest。只回復程式映像，不回復資料庫；重新啟動後重跑 smoke test。
- **不相容或未證明相容**：先停止所有寫入及所有應用容器，保留當前資料庫的加密事故備份。執行 `./infra/backup/verify-rollback-preflight.sh <發佈前備份> <現行外部刪除 ledger>`。若 ledger 的行數或 hash 已前進，**禁止資料庫回復**：舊備份不能重放已審計刪除，回復會導致已刪資料復活；保持平台停止並以 forward-fix migration 處理。

只有 preflight 證明外部 tombstone ledger 與發佈前備份完全相同，才可在全新隔離 PostgreSQL/volume 按 `infra/backup/README.md` 設定 staging/test marker 及執行 `restore.sh`。驗證 schema、migration ledger、列數、刪除記錄和 Excel 後，設定 `PROMOTE_PGSERVICE`、`PROMOTE_CONFIRM_DATABASE`、`RESTORE_ALLOWED_TARGET_ID`、`DELETION_LEDGER_FILE`、簽署驗證變數及 `PROMOTE_CONFIRM=PROMOTE_VERIFIED_RESTORE_TO_PRODUCTION`，執行 `./infra/backup/promote-restored-target.sh <發佈前備份>`。它會持有外部 ledger lock、重驗 hash/行數及簽署、核對 staging marker 與 deletion audit 列數，然後在 advisory-lock transaction 把 marker 改為 `production/restore_allowed=false`。只在它成功後才可用新 `DATABASE_URL` 切換，部署上一個精確映像 digest；不可手寫反向 SQL、合併 ledger 或繞過 promotion guard。

回復後重跑全部 smoke test，核對 migration ledger、restore target ID、刪除 ledger 及對戰記錄。保留時間、執行人、原因、前後 digest、備份 manifest 與驗證結果。
