# 發佈與回復手冊

## 發佈前關卡

1. 只發佈 CI `quality` 及 `production-security` 全部通過的 commit。`release-images` 會推送映像並產生 GitHub artifact attestation。CI 命令是 `./scripts/portable-sha256.sh manifest release server.json web.json database.json release-manifest.json > release/SHA256SUMS`，artifact 必須精確包含非隱藏 `release/` 的這五個檔案，checksum 項目必須是 basename。另外從 CI run 記錄 manifest SHA-256、repository 及 commit；同目錄 `SHA256SUMS` 不構成獨立授權。
2. 停止會寫入資料庫的發佈工作，按 [`infra/backup/README.md`](../../infra/backup/README.md) 設定受限的 `PGSERVICE`、`PGPASSFILE`、`BACKUP_DIR`、`AGE_RECIPIENT` 及簽署鍵，執行 `./infra/backup/backup.sh`。備份必須是含簽署 manifest 的 age 加密 `dump.age`，並另存於受控位置。立即在隔離 PostgreSQL 實例執行 `./infra/backup/restore.sh <完整備份目錄>` 還原演練，核對 backup manifest、migration ledger 及記錄數量；未能還原的備份不算可用。
3. 核對正式環境 secret 沒有寫入 Git、image 或日誌，再用 `scripts/validate-deployment-env.mjs` 驗證 HTTPS origin 及映像 digest。

## 發佈

1. 從已驗證 artifact 讀取 `images.server`、`images.web` 及 `images.database`，分別寫入受限 env file 的 `SERVER_IMAGE`、`WEB_IMAGE`、`DATABASE_IMAGE`。`images.migration` 必須與 `images.server` 完全相同。
2. Compose 的 `migration` 是唯一 migration owner：它執行 `migrate-and-start.sh --migrate-only`，由應用 migration runner 取得 PostgreSQL advisory lock，在同一 transaction 核對 SQL SHA-256 與 `app_schema_migrations` ledger。失敗時非零離開，server 因 `service_completed_successfully` 依賴而不會啟動。
3. 正式環境唯一受支援的入口是受 `production` environment 保護的 `Deploy and record protected production release` workflow。它下載及驗證 attested artifact，再透過 SSH 調用主機上的 `host-deploy-and-receipt.sh`；主機 lock 會跨越 protected-state recheck、`deploy-production.sh`、Compose pull/up、public smoke 及 receipt 產生。直接執行 `docker compose` 不受支援。
4. 記錄實際應用映像 digest、release manifest digest 及 migration outcome。正式 `compose.yaml` 不含 build，因此不會把 local mutable tag 當成發佈物；`compose.build.yaml` 只供 CI 生產測試。

私有 repository 的部署主機使用 root-owned 0600 `PRODUCTION_STATE_TOKEN_FILE`，token 只需 Actions/Deployments 讀取權，不得寫入 env file、shell history、log 或 sudo command line。主機另需 root-owned receipt 簽署鍵、PGSERVICE/PGPASSFILE、教師 smoke 密碼檔；workflow 只傳送這些受信路徑，不傳送 secret 內容。無 GitHub 認證、host receipt 驗簽或 protected state 不一致時必須 fail closed。

## Smoke test

`production-smoke.sh` 從 strict canonical `PUBLIC_ORIGIN` 取 hostname，以 `curl --resolve host:443:127.0.0.1` 保留 SNI、Host 及 CA 驗證，檢查首頁、`/health/ready`、強制 WebSocket upgrade、教師登入/session 及記錄讀取。Host receipt 必須綁定此 origin/smoke、container ID/RepoDigests、DB system identifier 及 production marker。CI 亦執行不可 skip 的 `pnpm test:security`；任一項失敗就停止發佈。

## 回復判斷

- **向後相容 migration**：手動啟動 `Authorize application rollback`，輸入 previous/current release run ID、artifact name、外部 manifest SHA-256 及 expected commit，再通過 `production-rollback-approval` environment 人工批准。workflow 只從 GitHub artifacts 下載及驗證兩個 attested subject，重建 previous server/web + current database manifest 並產生新 attestation。`prepare-application-rollback.sh` 只供本地演練，未授權候選物不可部署。

如必須回退 database engine，需在獨立變更中證明 engine major、data-directory format、extension 和 `pg_upgrade`/還原路徑相容，並以新 volume 演練。本 wrapper 沒有收到這份相容證據時必須拒絕 database engine rollback。
- **不相容或未證明相容**：先停止所有寫入及所有應用容器，保留當前資料庫的加密事故備份。執行 `./infra/backup/verify-rollback-preflight.sh <發佈前備份> <現行外部刪除 ledger>`。若 ledger 的行數或 hash 已前進，**禁止資料庫回復**：舊備份不能重放已審計刪除，回復會導致已刪資料復活；保持平台停止並以 forward-fix migration 處理。

只有 preflight 證明外部 tombstone ledger 未前進，才可在全新隔離 PostgreSQL/volume 還原。先停止 app/migration 及網路入口，再設定 `PROMOTE_PGSERVICE`、連至 maintenance DB 的 `PROMOTE_MAINTENANCE_PGSERVICE`、`PROMOTE_APP_ROLE`、`PROMOTE_CONFIRM_DATABASE`及其他驗證變數。執行帳號必須是 DB owner/superuser，並有 `pg_signal_backend`。腳本會在現有控制 session 內先 `ALLOW_CONNECTIONS false`、終止其他 session、證明隔離，才進入 advisory-lock validation/marker transaction；trap 在成功或失敗都透過 maintenance service 恢復 `ALLOW_CONNECTIONS true`。

回復後重跑全部 smoke test，核對 migration ledger、restore target ID、刪除 ledger 及對戰記錄。保留時間、執行人、原因、前後 digest、備份 manifest 與驗證結果。

## Rollback 及 cutover 硬關卡

Rollback operator 只能輸入 previous release；current release 必須從 GitHub 最新成功 `production` Deployment payload 解析。`production-rollback-approval` 必須在 repository 設定 required reviewers 及 deployment branch policy，`verify-rollback-go-live.mjs` 以具 Environments 讀取權限的 token 查 API，未配置即 fail closed。

Promotion 成功後只寫 root-owned 0400 `promotion-ready`，PUBLIC 及 app role 仍無 CONNECT。完成外部 `DATABASE_URL` routing 後，root 先執行完整 public smoke，再以 `record-cutover-receipt.sh <promotion-ready> <cutover-receipt>` 產生綁定 system identifier、restore target、canonical DATABASE_URL hash、deployment manifest、origin/smoke 及 nonce 的簽署 receipt。只可以 `finalize-cutover.sh <promotion-ready> <cutover-receipt> <signature>` grant app role；finalize 會在 transaction 內重驗 marker、ACL 及 ledgerRows，PUBLIC 永不 grant，receipt 一次性消耗並寫 audit。若出現 root/private `RECOVERY-REQUIRED`，保留 incident 目錄及 `.promotion-reserved`，用 maintenance service 執行 `ALTER DATABASE <PROMOTE_CONFIRM_DATABASE> ALLOW_CONNECTIONS true;`，核對 marker/ACL 後才人工 reconcile。
