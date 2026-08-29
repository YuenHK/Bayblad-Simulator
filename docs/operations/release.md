# 發佈與回復手冊

## 發佈前關卡

1. 只發佈 CI `quality` 及 `production-security` 全部通過的 commit。`release-images` 會推送映像並產生 GitHub artifact attestation。CI 命令是 `./scripts/portable-sha256.sh manifest release server.json web.json database.json release-manifest.json > release/SHA256SUMS`，artifact 必須精確包含非隱藏 `release/` 的這五個檔案，checksum 項目必須是 basename。另外從 CI run 記錄 manifest SHA-256、repository 及 commit；同目錄 `SHA256SUMS` 不構成獨立授權。
2. 停止會寫入資料庫的發佈工作，按 [`infra/backup/README.md`](../../infra/backup/README.md) 設定受限的 `PGSERVICE`、`PGPASSFILE`、`BACKUP_DIR`、`AGE_RECIPIENT` 及簽署鍵，執行 `./infra/backup/backup.sh`。備份必須是含簽署 manifest 的 age 加密 `dump.age`，並另存於受控位置。立即在隔離 PostgreSQL 實例執行 `./infra/backup/restore.sh <完整備份目錄>` 還原演練，核對 backup manifest、migration ledger 及記錄數量；未能還原的備份不算可用。
3. 核對正式環境 secret 沒有寫入 Git、image 或日誌，再用 `scripts/validate-deployment-env.mjs` 驗證 HTTPS origin 及映像 digest。

## 發佈

1. 從已驗證 artifact 讀取 `images.server`、`images.web` 及 `images.database`，分別寫入受限 env file 的 `SERVER_IMAGE`、`WEB_IMAGE`、`DATABASE_IMAGE`。`images.migration` 必須與 `images.server` 完全相同。
2. Compose 的 `migration` 是唯一 migration owner：它執行 `migrate-and-start.sh --migrate-only`，由應用 migration runner 取得 PostgreSQL advisory lock，在同一 transaction 核對 SQL SHA-256 與 `app_schema_migrations` ledger。失敗時非零離開，server 因 `service_completed_successfully` 依賴而不會啟動。
3. 正式環境唯一受支援的入口是受 `production` environment 保護的 `Deploy and record protected production release` workflow。Runner 先重查 GitHub state；主機的 root-only `prepare-deployment-authorization.sh` 再驗 attestation 與同一 Deployment API binding，原子產生 0400 one-time authorization snapshot。其後 non-root deploy user 以 exact sudo 啟動 `host-deploy-and-receipt.sh`；主機 lock 內會驗證並 consume snapshot，再執行 `deploy-production.sh`、Compose pull/up、public smoke 及 receipt。Locked core 與 `deploy-production.sh` 不再直接存取 GitHub API。直接執行 `docker compose` 不受支援。

Tag 產生的 `release-manifest-*` 只是 candidate。`release-host-core-integration` 會使用獨立 GitHub environment `release-host-integration`、固定 project `steam-top-release-integration`、loopback ports 18080/18443/15432、獨立 lock/state/outbox/volumes及本地 CA，透過非 root exact sudo 真正執行同一 host core與完整 smoke。只有成功後才 attested/upload `approved-release-<commit>`；正式 normal deploy 拒絕 candidate，只接受 approved artifact。Cleanup 固定 project並 `down -v --remove-orphans`，不得觸碰 production project/volumes。
4. 記錄實際應用映像 digest、release manifest digest 及 migration outcome。正式 `compose.yaml` 不含 build，因此不會把 local mutable tag 當成發佈物；`compose.build.yaml` 只供 CI 生產測試。

私有 repository 的部署主機使用 root-owned 0600 `PRODUCTION_STATE_TOKEN_FILE`，token 只需 Actions/Deployments 讀取權，不得寫入 env file、shell history、log 或 sudo command line。主機另需 root-owned receipt 簽署鍵、PGSERVICE/PGPASSFILE、教師 smoke 密碼檔；workflow 只傳送這些受信路徑，不傳送 secret 內容。無 GitHub 認證、host receipt 驗簽或 protected state 不一致時必須 fail closed。

部署主機明確要求 Linux、GNU `flock`、Docker/Compose、Node、`gh`、`psql` 及 `ssh-keygen`。Tag workflow 會產生並獨立 attestation `runtime-files.sha256`；安裝者必須先以 `gh attestation verify runtime-files.sha256 --repo <owner/repo> --signer-workflow <owner/repo>/.github/workflows/ci.yml` 驗證來源，再把已審核 commit 安裝至 `/opt/steam-top`，以外部已驗 digest 執行 root-only `seal-runtime-install.sh <runtime-files.sha256> <sha256> <commit>`。該步驟把每個執行／import 檔固定為 root-owned 0555/0444，並產生 root-owned 0444 `runtime-install-receipt.json`；preparer、host core 及 finalize 每次均重驗相同外部 digest，主機不可自行建立另一份 checksum 自證。所有父目錄必須 root-owned 且 group/other 不可寫。預先建立 root-owned 0600 regular file `/var/lock/steam-top-production.lock`、root-owned 0700 authorization directory及 receipt outbox，不可是 symlink。`sudoers` 只允許部署 SSH 帳號依序執行精確的 `/opt/steam-top/scripts/prepare-deployment-authorization.sh`、`/opt/steam-top/scripts/host-deploy-and-receipt.sh` 及 `/opt/steam-top/scripts/fetch-host-receipt.sh`，禁止任意 shell/任意 script path。每次升級後要再核對 canonical path、owner、mode、sealed receipt 及 sudoers。

Receipt 不可先複製成非 root 可讀檔案；非 root deploy user 只能透過上述 exact sudo command 取得 `RECEIPT-BEGIN`／base64 payload／`RECEIPT-SIGNATURE`／`RECEIPT-END` framed stdout。CI 會實際建立受限帳號及 sudoers、驗證 direct outbox read 被拒，並解析完整 frame。

Authorization 在 Compose 前由 `pending` 轉為 `deploying`，不會在 command 中斷時假定未產生效果。同 nonce 重試時，host lock 內先 inspect 實際 containers 及 immutable RepoDigests：零容器才可安全重跑 deploy；全部 service/project/config image/running-health/migration exit 均精確相符才可補跑 smoke 及 receipt；任何部分或不符狀態會產生 root-private `RECOVERY-REQUIRED` 並把 authorization 設為 `failed`，禁止盲目 `up`。

## Smoke test

`production-smoke.sh` 從 strict canonical `PUBLIC_ORIGIN` 取 hostname，以 `curl --resolve` 保留 SNI、Host 及 CA 驗證，檢查 HTTP redirect、首頁/實際 asset、`/health/ready`、Node `socket.io-client` strict-TLS WebSocket transport、教師登入、nonce-bound DB deployment probe、logout 及 session 已失效。密碼只從 root 0600 JSON file 讀入 request body，不出現於 argv/log。Host receipt 必須綁定此 origin/smoke、精確 Compose service/config hash/container state、separate image RepoDigests、DB system identifier 及 production marker。

## 回復判斷

- **向後相容 migration**：手動啟動 `Authorize application rollback`，輸入 previous/current release run ID、artifact name、外部 manifest SHA-256 及 expected commit，再通過 `production-rollback-approval` environment 人工批准。workflow 只從 GitHub artifacts 下載及驗證兩個 attested subject，重建 previous server/web + current database manifest 並產生新 attestation。`prepare-application-rollback.sh` 只供本地演練，未授權候選物不可部署。

如必須回退 database engine，需在獨立變更中證明 engine major、data-directory format、extension 和 `pg_upgrade`/還原路徑相容，並以新 volume 演練。本 wrapper 沒有收到這份相容證據時必須拒絕 database engine rollback。
- **不相容或未證明相容**：先停止所有寫入及所有應用容器，保留當前資料庫的加密事故備份。執行 `./infra/backup/verify-rollback-preflight.sh <發佈前備份> <現行外部刪除 ledger>`。若 ledger 的行數或 hash 已前進，**禁止資料庫回復**：舊備份不能重放已審計刪除，回復會導致已刪資料復活；保持平台停止並以 forward-fix migration 處理。

只有 preflight 證明外部 tombstone ledger 未前進，才可在全新隔離 PostgreSQL/volume 還原。先停止 app/migration 及網路入口，再設定 `PROMOTE_PGSERVICE`、連至 maintenance DB 的 `PROMOTE_MAINTENANCE_PGSERVICE`、`PROMOTE_APP_ROLE`、`PROMOTE_CONFIRM_DATABASE`及其他驗證變數。執行帳號必須是 DB owner/superuser，並有 `pg_signal_backend`。腳本會在現有控制 session 內先 `ALLOW_CONNECTIONS false`、終止其他 session、證明隔離，才進入 advisory-lock validation/marker transaction；trap 在成功或失敗都透過 maintenance service 恢復 `ALLOW_CONNECTIONS true`。

回復後重跑全部 smoke test，核對 migration ledger、restore target ID、刪除 ledger 及對戰記錄。保留時間、執行人、原因、前後 digest、備份 manifest 與驗證結果。

## Rollback 及 cutover 硬關卡

Rollback operator 只能輸入 previous release；current release 必須從 GitHub 最新成功 `production` Deployment payload 解析。`production-rollback-approval` 必須在 repository 設定 required reviewers 及 deployment branch policy，`verify-rollback-go-live.mjs` 以具 Environments 讀取權限的 token 查 API，未配置即 fail closed。

Promotion 成功後只寫 root-owned 0400 `promotion-ready`，PUBLIC 及 app role 仍無 CONNECT。完成外部 `DATABASE_URL` routing 後，root 先執行完整 public smoke，再以 `record-cutover-receipt.sh <promotion-ready> <cutover-receipt>` 產生綁定 system identifier、restore target、canonical DATABASE_URL hash、deployment manifest、origin/smoke 及 promotion nonce 的簽署 receipt。只可以 `finalize-cutover.sh <promotion-ready> <cutover-receipt> <signature>` grant app role；執行時必須同時提供 `RUNTIME_INSTALL_MANIFEST_SHA256`、root-private `PRODUCTION_ENV_FILE`、`PROTECTED_DEPLOYMENT_STATE_FILE`、`HOST_DEPLOYMENT_RECEIPT_FILE` 及其簽署/allowed-signers。Finalize 不只信 cutover receipt，會再驗 host receipt 簽署、current protected deployment、canonical origin/DB identity、marker、ACL 及 ledgerRows；PUBLIC 永不 grant，receipt 一次性消耗並寫 audit。若出現 root/private `RECOVERY-REQUIRED`，保留 incident 目錄及 `.promotion-reserved`，用 maintenance service 執行 `ALTER DATABASE <PROMOTE_CONFIRM_DATABASE> ALLOW_CONNECTIONS true;`，核對 marker/ACL 後才人工 reconcile。

Promotion/finalize 的 commit authority 分別是 DB `promotion_outbox` 及 `finalize_outbox`，不是 filesystem phase file。若 transaction 已 commit 但 ready/archive 寫入中斷，狀態必須視為「DB 已完成、filesystem 待 reconcile」，不可當作失敗並回復舊 ACL。在 app 仍停流量時以同一 nonce 執行 `reconcile-promotion-ready.sh` 或 `reconcile-finalize-outbox.sh`；它們只從 DB authoritative row 幂等地重建/完成檔案，已完成檔必須與 authoritative fields/digest 相符，不重做 grant 或寫 audit。

Promotion 的受限 operator 必須是目標 database owner（供 `ALTER DATABASE`），並只額外取得 `pg_signal_backend` 及 restore schema/table/sequence 所需權限；不要求 superuser。Maintenance service 必須連同一 cluster 的另一 database，preflight 會比較 `system_identifier`，不同 cluster 一律拒絕。若 app role 經 parent role 繼承 `CONNECT`，direct revoke 後的 effective privilege 仍為 true，promotion 會在 transaction 內 fail closed；正式設定應使用不含任何 inherited `CONNECT` 的專用 app role。
