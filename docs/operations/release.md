# 發佈與回復手冊

## 發佈前關卡

1. 只發佈 CI `quality` 及 `production-security` 全部通過的 commit。`release-images` 會推送映像並產生 GitHub artifact attestation。CI 命令是 `./scripts/portable-sha256.sh manifest release server.json web.json database.json release-manifest.json > release/SHA256SUMS`，artifact 必須精確包含非隱藏 `release/` 的這五個檔案，checksum 項目必須是 basename。另外從 CI run 記錄 manifest SHA-256、repository 及 commit；同目錄 `SHA256SUMS` 不構成獨立授權。
2. 停止會寫入資料庫的發佈工作，按 [`infra/backup/README.md`](../../infra/backup/README.md) 設定受限的 `PGSERVICE`、`PGPASSFILE`、`BACKUP_DIR`、`AGE_RECIPIENT` 及簽署鍵，執行 `./infra/backup/backup.sh`。備份必須是含簽署 manifest 的 age 加密 `dump.age`，並另存於受控位置。立即在隔離 PostgreSQL 實例執行 `./infra/backup/restore.sh <完整備份目錄>` 還原演練，核對 backup manifest、migration ledger 及記錄數量；未能還原的備份不算可用。
3. 核對正式環境 secret 沒有寫入 Git、image 或日誌，再用 `scripts/validate-deployment-env.mjs` 驗證 HTTPS origin 及映像 digest。

## 發佈

1. 從已驗證 artifact 讀取 `images.server`、`images.web` 及 `images.database`，分別寫入受限 env file 的 `SERVER_IMAGE`、`WEB_IMAGE`、`DATABASE_IMAGE`。`images.migration` 必須與 `images.server` 完全相同。
2. Compose 的 `migration` 是唯一 migration owner：它執行 `migrate-and-start.sh --migrate-only`，由應用 migration runner 取得 PostgreSQL advisory lock，在同一 transaction 核對 SQL SHA-256 與 `app_schema_migrations` ledger。失敗時非零離開，server 因 `service_completed_successfully` 依賴而不會啟動。
3. 正式環境唯一受支援的入口是受 `production` environment 保護的 `Deploy and record protected production release` workflow。Runner 先重查 GitHub state；主機的 root-only `prepare-deployment-authorization.sh` 再驗 attestation 與同一 Deployment API binding，原子產生 0400 one-time authorization snapshot。其後 non-root deploy user 以 exact sudo 啟動 `host-deploy-and-receipt.sh`；主機 lock 內會驗證並 consume snapshot，再執行 `deploy-production.sh`、Compose pull/up、public smoke 及 receipt。Locked core 與 `deploy-production.sh` 不再直接存取 GitHub API。直接執行 `docker compose` 不受支援。

Tag 產生的 `release-manifest-*` 只是 candidate。`release-host-core-integration` 會使用獨立 GitHub environment `release-host-integration`、固定 project `steam-top-release-integration`、loopback ports 18080/18443/15432、獨立 lock/state/outbox/volumes及本地 CA，透過非 root exact sudo 真正執行同一 host core與完整 smoke。Host core 產生的真實 signed receipt／monotonic ledger 隨即經 integration-purpose canonical activation，再走 promotion、`record-cutover-current.sh`、`finalize-current.sh`；最後把 server 強制重連至非 owner `steam_top_app` 並重跑完整 public smoke。只有整條鏈成功後才 attested/upload `approved-release-<commit>`；正式 normal deploy 拒絕 candidate，只接受 approved artifact。Production 與 integration 的 purpose、lock、state、runtime pointer 均不可互換。Cleanup 固定 project並 `down -v --remove-orphans`，不得觸碰 production project/volumes。
4. 記錄實際應用映像 digest、release manifest digest 及 migration outcome。正式 `compose.yaml` 不含 build，因此不會把 local mutable tag 當成發佈物；`compose.build.yaml` 只供 CI 生產測試。

私有 repository 的部署主機使用 root-owned 0600 `PRODUCTION_STATE_TOKEN_FILE`，token 只需 Actions/Deployments 讀取權，不得寫入 env file、shell history、log 或 sudo command line。主機另需 root-owned receipt 簽署鍵、PGSERVICE/PGPASSFILE、教師 smoke 密碼檔；workflow 只傳送這些受信路徑，不傳送 secret 內容。無 GitHub 認證、host receipt 驗簽或 protected state 不一致時必須 fail closed。

部署主機明確要求 Linux、GNU `flock`、Docker/Compose、Node、`gh`、`psql` 及 `ssh-keygen`。信任根不屬於任何 tag/release：校方主機管理員必須由獨立、受保護 default-branch `bootstrap.yml` artifact 一次性人工安裝 `/opt/steam-top-bootstrap`。執行 `install-bootstrap.sh` 時必須從主機外提供 `EXPECTED_BOOTSTRAP_ARCHIVE_SHA256`、`BOOTSTRAP_ALLOWED_SIGNERS_FILE`、archive 簽署及 root-private trust config；config 固定 repository、protected workflow identity/ref/SHA、bootstrap manifest digest、主機 secrets/state paths，release workflow 無權改寫。Bootstrap 目錄及父目錄 root-owned 0555，執行檔 0555、module 0444、config/manifest 0400。

Tag workflow 產生獨立 attestation `runtime-files.sha256` 及 `release/runtime/` exact files；受 production environment 保護的 default-branch record workflow 再產生 nonce-bound `deployment-authorization.json` attestation。預安裝 bootstrap 會同時驗證 GitHub attestation、approved marker、repo/commit、protected workflow ref/SHA，才把 runtime 安裝至 `/opt/steam-top/releases/<runtime-manifest-sha256>`，並原子更新 `/opt/steam-top/current`。`sudoers` 只允許精確的 `/opt/steam-top-bootstrap/deploy-release.sh` 及 `/opt/steam-top-bootstrap/fetch-receipt.sh`，永不允許 candidate/release 內的 executable path。

主機在同一 production lock 內核對 authorization 的 `expectedPreviousState` 與 root0700 outbox 內 `deployment-ledger.json`。只有實際 container/image/DB 核對、公開 smoke 及 host receipt 簽署完成後，才會以 `steam-top-host-deployment-ledger` namespace 原子推進 ledger；同 nonce retry 只可重播相同 receipt，stale predecessor 或並行 actor 必須拒絕。Bootstrap 在建立 signed protected state 前會再驗 ledger signature、deployment id、manifest、nonce 及 predecessor chain，因此 GitHub status 不能單獨冒充主機已部署狀態。

Protected current 並非可覆寫的單一 JSON：主機以 root0400 payload/signature generation、連續 hash 及原子 pointer 保留每代狀態。`record-deployment.yml` 必須先執行預裝 bootstrap `activate-production-state.sh`，驗簽 nonce-bound activation receipt 後才可把 GitHub Deployment 標為 success。如 runner 在其間中斷，只可用 `reconcile-deployment.yml` 從 bootstrap `fetch-receipt.sh` 取得原主機 receipt，再幂等 activate 及驗簽 activation receipt；若 latest deployment、manifest、nonce 或 predecessor 已變，必須拒絕，不得把舊 deployment 復活。Pointer 中斷時只可從驗簽且 hash-chain 完整的最新 generation 復原。

`db.yml` 的 root-owned `/opt/steam-top` 只是一次性 PostgreSQL 功能 integration fixture，不是 production bootstrap 證據、不會產生可供正式部署信任的 state。正式 acceptance 必須取得校方主機上 `/opt/steam-top-bootstrap/verify-bootstrap.sh` 的 digest 證據，並與受保護 `bootstrap.yml` artifact 及主機 root0400 config 相符。

`production-security` 另會在全新 runner 以簽署 bootstrap archive 安裝一次性 component fixture，驗證 promotion／outbox／canonical wrapper 的功能與 lock 行為。測試用 backup/operator 只屬 production-like fixture，不代表真實備份或校方主機部署證據；只有受保護 tag `release-host-core-integration` 會走 actual host receipt/ledger、preflight、provisional app reconnect、完整 public smoke及 confirm 的整條路徑。

此資料庫關卡的受限 `gh` fixture 只核對 activation 所用 API 的完整 argv、endpoint、token 及回傳 binding，並保存 calls；它不構成 GitHub attestation 或正式 Deployment state 證據。正式 host receipt/ledger 只由受保護 tag hard gate 的 `host-deploy-and-receipt.sh` 產生及驗證。Cutover 後 CI 會以非 owner `steam_top_app` 強制重建 server 連線，再跑完整 smoke，避免 owner 身分令 CONNECT freeze 測試失真。

`bootstrap-release-approval` 環境必須有 required reviewers 及 restrictive branch policy，並預先由管理員輪換 `EXPECTED_BOOTSTRAP_ARCHIVE_SHA256` 與 `BOOTSTRAP_SIGNING_KEY`。`release-host-integration` 環境只接受管理員固定的 `BOOTSTRAP_RUN_ID`/`BOOTSTRAP_COMMIT`/`BOOTSTRAP_ARCHIVE_SHA256` 及 `BOOTSTRAP_ALLOWED_SIGNERS`；tag job 會從該 protected run 下載 bootstrap，核對外部 digest、GitHub attestation 及 SSH signature，不會用 tag checkout 內的 bootstrap 作信任根。任何 digest 輪換都必須先審閱 bootstrap source，再更新受保護 environment variable；release workflow 無權自行改寫。

Installer 來源必須同時受 `INSTALLER_ALLOWED_HOSTS`、無 redirect HTTPS/TLS 1.3、外部 SHA256 及 SSH signature 限制；URL、signature URL、digest 及 allowlist 會寫入 root-private bootstrap trust audit。輪換時要先由主機管理員審閱新 installer bytes/簽署，再同步更新受保護 variables，不可只改 URL。Hard gate 保留 `gh attestation verify --format json` 的 bootstrap 與 authorization 真實 evidence，並使用與 production bootstrap 相同的 exact subject/ref/workflow SHA verifier；schema 漂移必須 fail closed。

`install-bootstrap.sh` 是主機 image provisioning 前置條件，不包在 bootstrap release artifact，也不允許從 candidate path 直接 sudo。主機管理員必須以校外已審核 `INSTALLER_SHA256` 及 `steam-top-bootstrap-installer` SSH signature 驗證 bytes，再安裝為 root-owned 0555 `/usr/local/sbin/install-steam-top-bootstrap`；sudoers 只可列出這個 canonical pinned path。更新 installer 時必須同時輪換外部 digest/signature，不可由 release artifact 自證。

傳給 installer 的 allowed-signers 必須是 root-owned `0444`，trust config 必須是 root-owned `0400`，兩者的所有父目錄均由 root 擁有且不可 group/world 寫入；symlink 或 runner-owned 暫存輸入會 fail closed。CI 只可先把已驗證內容安裝到 root-private `/run` staging，再呼叫 pinned installer。

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

Production cutover 只可使用預先安裝的 `/opt/steam-top-bootstrap/record-cutover-current.sh`、`finalize-current.sh`、`confirm-cutover-current.sh` 及 `abort-cutover-current.sh`。入口會自行解析並驗證目前 protected generation；直接向 runtime script 傳入自行組合的 state path 屬不支援操作，並會被拒絕。

`hostReceiptSigningKey`、`ledgerSigningKey`、`evidenceSigningKey` 與 `productionStateSigningKey` 必須分開，全部由 root 擁有並設為 `0400`。輪換時先加入及驗證新 public identity，才更改相應 private-key path；舊 identity 要保留至其簽署 generation 完成審計保留期，並在變更紀錄保存新舊 key fingerprint。receipt key 不可重用作 ledger 或 authorization evidence key。

每個 writer 在寫 generation/pointer 前必須由 private key 導出 public key，精確匹配 envelope 的 `signerKeyId` 及 allowed-signers，簽署後再即時驗簽。輪換測試須以 old→new 混合 chain 證明兩者同時可驗；保留期完結前移除 old identity 必須令舊 chain fail closed，而不是靜默略過。

Bootstrap trust config 同時要設定 `ledgerAllowedSigners` 及 `ledgerSignerId`；activation 只以該 ledger identity 驗證完整 host ledger chain，不會接受 host receipt identity 代替。

輪換範例：先把 `new-key-id ssh-ed25519 ...` 加入相應 root-owned `0444` allowed-signers file，驗證舊／新 key 都可讀取既有 mixed-key chain，再把 writer config 指向新的 root-owned `0400` private key 及 `new-key-id`。完成一個已驗證 checkpoint generation 後，舊 public identity 仍須保留至所有舊 generation 超出永久審計保留範圍；移除前要再次掃描完整 chain。部署主機規格固定為 Linux，須提供 `flock`、GNU `stat`、GNU `tar` 及支援 `sync -f` 的 coreutils；不可在未驗證的 BSD userland 直接執行 production bootstrap。

Host provisioning 必須預建 `/var/lock/steam-top-generation-publish.lock`、`/var/lock/steam-top-production.lock` 及 `/var/lock/steam-top-release-integration.lock`，全部 root-owned `0600` 且不可為 symlink。Runtime publisher 不會自行建立 lock；缺失或 mode/owner 不符會 fail closed。

Rollback operator 只能輸入 previous release；current release 必須從 GitHub 最新成功 `production` Deployment payload 解析。`production-rollback-approval` 必須在 repository 設定 required reviewers 及 deployment branch policy，`verify-rollback-go-live.mjs` 以具 Environments 讀取權限的 token 查 API，未配置即 fail closed。

Promotion 成功後只寫 root-owned 0400 `promotion-ready`，PUBLIC 及 app role 仍無 CONNECT，server 必須停止。`record-cutover-current.sh` 只經 maintenance PGSERVICE 核對 target system ID、restore target、marker、ledger、probe nonce、canonical DATABASE_URL identity 與 routing config digest，簽 preflight receipt並把 outbox 設為 `preflight-recorded`；此階段明確不執行、亦不聲稱 public smoke。`finalize-current.sh` 只 provisional grant app CONNECT，把 outbox 設為 `connect-granted-pending-smoke`，不代表 cutover 完成。其後立即以 `steam_top_app` 強制重建 server，跑完整 HTTPS/WSS/admin/probe smoke，再由 `confirm-cutover-current.sh` 驗證同一 nonce／DB identity並把狀態推進至 `verified`，只有 verified 才可批准 release。PUBLIC 永不 grant。

如 provisional grant 後 smoke 失敗或 runner 中斷，必須執行 `abort-cutover-current.sh`：它只接受同一 pending nonce，撤銷 app CONNECT、終止該角色 session、寫 `aborted` 及 root0600 incident，workflow 必須失敗。若主機顯示 `connect-granted-pending-smoke` 而沒有 final signed receipt，不可建立 APPROVED；人工只能在重新取得完整 smoke 證據後 confirm，或選擇 abort。`steam_top_app` 只獲 app schema 所需權限、`restore_control` USAGE 及 `deployment_probe` SELECT/UPDATE；host operator 負責 INSERT，app 不可讀其他 restore-control tables。

Host provisioning 必須安裝 [steam-top-cutover-reaper.service] 及 `.timer` 至 `/etc/systemd/system/`，執行 `systemctl daemon-reload && systemctl enable --now steam-top-cutover-reaper.timer`。Bootstrap trust config 必須以 root0400 提供 `cutoverPgService`、`cutoverPgServiceFile`、`cutoverPgPassFile` 及 `cutoverIncidentDir`。Timer 每分鐘透過預裝 `/opt/steam-top-bootstrap/reconcile-cutover-pending.sh` 掃描已過五分鐘 deadline 的 pending row；它只信 DB capsule 的 nonce/role/target/system/database/ledger/artifact digests，重新核對 live identity 後 revoke、terminate、以 generation 條件更新 aborted。故 runner 被強制取消仍不會永久留下 app CONNECT。啟動部署前及 workflow `always()` 亦應先執行一次 reaper；reaper 失敗時保留 volume 與 recovery evidence，禁止 APPROVED。

Promotion/cutover 的 commit authority 分別是 DB `promotion_outbox` 及 `finalize_outbox`，不是 filesystem phase file。Cutover outbox 的合法順序是 `preflight-recorded → connect-granted-pending-smoke → verified`，失敗 recovery 則由 pending 進入 `aborted`；任何其他跳轉均須 fail closed。Promotion ready 仍由 `reconcile-promotion-ready.sh` 從 DB authoritative row 幂等重建；cutover pending 不得被 filesystem receipt 假裝成 verified。

舊版 `committed` cutover migration 後只會成為 `legacy-committed`，絕不等同 APPROVED。管理員須保留舊 root-owned 0400 final receipt、簽署及 signer allowlist，停止流量後以 canonical runtime 的 `import-legacy-cutover.sh` 匯入；腳本在 advisory lock 內只接受 `production-cutover-verified` 簽署及相同 nonce，才轉成 `verified`。欠缺舊簽署證據時必須保持 legacy 狀態。

Promotion 的受限 operator 必須是目標 database owner（供 `ALTER DATABASE`），並只額外取得 `pg_signal_backend` 及 restore schema/table/sequence 所需權限；不要求 superuser。Maintenance service 必須連同一 cluster 的另一 database，preflight 會比較 `system_identifier`，不同 cluster 一律拒絕。若 app role 經 parent role 繼承 `CONNECT`，direct revoke 後的 effective privilege 仍為 true，promotion 會在 transaction 內 fail closed；正式設定應使用不含任何 inherited `CONNECT` 的專用 app role。

Canonical record-cutover wrapper 在 provisional grant 前必須驗簽 protected generation、對應 activation receipt及 host deployment receipt，並核對 activation 的 state digest/nonce/deployment/time。Preflight `createdAt` 來自 DB deployment-probe 的固定 `created_at`，retry 不得用 wall clock 重寫或產生第二種 receipt；public smoke 只可在 provisional grant及 server 以 app role 重連後執行。
