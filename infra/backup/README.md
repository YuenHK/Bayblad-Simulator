# 加密備份及還原手冊

正式紀錄預設永久保留，系統不會按年齡自動刪除資料。這裡的 30 份限制只適用於每日加密備份檔；學生紀錄只能經教師後台的預覽、重新驗證、精確確認及不可變刪除稽核流程移除。

## 服務目標

- RPO（可接受資料損失）：每日備份時為 24 小時。若學校需要更低 RPO，應增加受監察的備份頻率，而不是減少保留份數。
- RTO（目標恢復時間）：4 小時，包括取得離線 age 私鑰、建立全新非正式驗證資料庫、還原、核對 schema／列數及由負責人批准切換。
- 每日至少保留最近 30 份完整備份。`backup.sh` 只會清理名稱完全符合 `steam-top-YYYYMMDDTHHMMSSZ-NNNNNN.backup`、包含有效 `COMPLETE` marker 的完整備份目錄；不完整 staging 及其他路徑不會被保留程序刪除。

## 建立備份

備份主機需要 PostgreSQL client、`age`、OpenSSH `ssh-keygen` 和 SHA-256 工具。備份目錄必須位於受限制的持久磁碟；腳本會建立 `0700` 目錄及 `0600` 檔案。資料庫連線只接受 libpq `PGSERVICE`；密碼應置於由秘密管理器產生的 `0600` `PGPASSFILE`，不可放在 URL 或命令列。

```bash
export PGSERVICE='steam_top_production_backup'
export PGSERVICEFILE='/受限制位置/pg_service.conf'
export PGPASSFILE='/受限制位置/pgpass'
export BACKUP_DIR='/srv/steam-top/backups'
export AGE_RECIPIENT='age1...'
export DELETION_LEDGER_FILE='/srv/steam-top/deletion-ledger/ledger.log'
export DELETION_SOURCE_INSTANCE_ID='與 restore_control marker 完全相符的 UUID'
export BACKUP_SIGNING_KEY='/離線或秘密管理器掛載/signing-key'
export BACKUP_ALLOWED_SIGNERS_FILE='/受限制位置/allowed_signers'
export BACKUP_SIGNER_ID='steam-top-backup-2026'
./infra/backup/backup.sh
```

備份及還原腳本只會使用相對於腳本目錄的 `apps/server/dist/admin/deletion-ledger-cli.js`，並以版本庫內唯讀的 `trusted-ledger-cli.sha256` 核對；任何環境均不能用環境變數改寫可執行檔路徑或摘要。可信建置完成及摘要核對後，部署管理員須把整個 release 目錄設為 `root:root` 並移除群組／其他使用者寫入權限，再把 CLI 設為 `0555`、摘要 manifest 設為 `0444`；正式 app／備份／還原帳戶必須是另一個非 root UID。腳本會同時核對 UID、mode 及不可替換的部署目錄，root 執行或 runtime 可改寫均 fail closed。無效或重複的備份組會移至私有 `.quarantine`；隔離區最多保留 20 組、總容量 1 GiB、最長 7 日，清理結果會輸出為操作遙測。

```bash
sudo chown -R root:root /opt/steam-top/releases/目前版本
sudo find /opt/steam-top/releases/目前版本 -type d -exec chmod go-w {} +
sudo chmod 0555 /opt/steam-top/releases/目前版本/apps/server/dist/admin/deletion-ledger-cli.js
sudo chmod 0444 /opt/steam-top/releases/目前版本/infra/backup/trusted-ledger-cli.sha256
```
腳本先在只讀 repeatable-read transaction 以 `pg_export_snapshot()` 固定快照；刪除稽核列數與 `pg_dump --snapshot` 因而來自完全相同的資料狀態，再把 custom-format dump 串流到 age recipient 加密。每個唯一 staging 目錄內的密文、checksum、manifest、ledger snapshot 及 OpenSSH 簽署會逐一 `fsync`；`COMPLETE` 最後寫入，再原子改名及同步父目錄。只有完整目錄才可還原。manifest 不包含 URL、密碼、學生姓名或篩選內容。

`DELETION_LEDGER_FILE` 是備份目錄以外、`0600` 的外部 append-only tombstone。`P` 同時保存資料庫 instance UUID 與 operation digest；提交後只可追加一次相符的 `C`，已知未執行只可追加一次 `A`。嚴格狀態機會拒絕孤立、重複、錯 digest 或互相衝突的紀錄。備份必須經正式 Node CLI 的 `snapshot` 子命令，在與寫入相同的 PID／OS process-start 鎖下取得一致副本；仍存活的程序即使暫停亦永不被搶鎖。任何未解決的 `P` 會令備份 fail closed；禁止手工追加或修改 ledger。運維人員只能使用用途為 `deletion_reconcile` 的一次性 reauth grant、完全確認字句及授權環境呼叫 CLI `reconcile`；CLI 會核對目前資料庫 instance UUID 及 `deletion_audit`。資料庫不可用、instance 不符或 grant 無效時不會改動 ledger。

一般 app、備份及還原程序永遠不會移除既有 canonical lock；即使 owner PID 已不存在，也只會回報 `STALE_LOCK_REQUIRES_MAINTENANCE`。若主機崩潰遺下 lock，必須安排離線維護時段：先停止並確認所有 app、worker、備份及還原程序均已停止；由 root 建立 `0600`、root-owned 的 maintenance marker，人工輸入完全相符字句 `I_CONFIRM_ALL_STEAM_TOP_APP_BACKUP_RESTORE_PROCESSES_ARE_STOPPED`，再於 ledger 同一檔案系統把 canonical lock單次原子改名至 root-only 隔離目錄。不得直接刪除、不得循環重試，也不得在服務仍運作時執行；改名後先保存 lock owner、inode、時間及操作者紀錄，確認 ledger 狀態機完整，才重新啟動服務。這是獨立的離線事故程序，不是日常 caller 的自動回收功能。

## 私鑰及輪替

age identity 及獨立 signing 私鑰不可放在程式庫、備份目錄或同一台資料庫主機。最少保留一份離線／受權限管理副本，並記錄可存取人員。每學年或任何疑似外洩後，同時輪替 age recipient 與 signing key：先把新 signing 公鑰加入 pinned allowed-signers，再切換兩個新私鑰並完成一次還原演練；舊 age 私鑰及舊 signing 公鑰須保留至其最後一份備份逾期，才可按學校密鑰銷毀程序移除。簽署私鑰不可與 age 私鑰共用。

## 還原演練

還原只接受明確的一個完整備份目錄。目標資料庫必須已存在、不得與 manifest 的來源資料庫相同；`APP_ENV=production` 或 `NODE_ENV=production` 會直接拒絕。目標確認字串必須完全等於實際連線的 database name，並同時通過資料庫內獨立 `restore_control` schema 的 marker。

```bash
export RESTORE_PGSERVICE='steam_top_restore_drill'
export PGSERVICEFILE='/受限制位置/pg_service.conf'
export PGPASSFILE='/受限制位置/pgpass'
export RESTORE_CONFIRM_DATABASE='steam_top_restore_20260829'
export AGE_IDENTITY_FILE='/受限制位置/steam-top-age-key.txt'
export DELETION_LEDGER_FILE='/srv/steam-top/deletion-ledger/ledger.log'
export NONPROD_RESTORE_CONFIRM='RESTORE_NONPRODUCTION_DATA'
export RESTORE_ALLOWED_TARGET_ID='由目標資料庫 deployment_environment 讀出的 UUID'
export BACKUP_ALLOWED_SIGNERS_FILE='/受限制位置/allowed_signers'
export BACKUP_SIGNER_ID='steam-top-backup-2026'
./infra/backup/restore.sh /srv/steam-top/backups/steam-top-20260829T010000Z-123456.backup
```

目標資料庫必須預先套用 migration，並由資料庫管理員在單一 transaction 先執行 `set local steam_top.configure_restore_target='RESTORE_NONPRODUCTION_DATA'`，再把 `restore_control.deployment_environment` 單例設為非 `production`、`restore_allowed=true`；一般 update/delete/truncate 均由 trigger 拒絕。操作者還須提供完全相符的 `restore_target_id`。整個 `restore_control` schema 不包含在 dump 內，還原前後均會核對。腳本先以 pinned signing 公鑰驗證簽署，再處理解密；並要求目前外部 deletion ledger 與備份 manifest 完全一致，舊備份即使密碼及簽署均正確也會被拒絕。

腳本先驗證檔名、非 symlink、manifest、內嵌 ledger 狀態機與密文 SHA-256，再啟動已釘選路徑及 digest 的 ledger guard；guard 以相同 OS lock 阻止刪除追加，直至 `pg_restore --single-transaction --clean --if-exists`、schema／列數及 marker 全部核對完成。每個新備份的簽署 manifest 包含唯一 backup UUID 及精確目錄名稱，通過完整驗證後才寫入另外簽署、同時綁定 manifest 與 checksum 的 `VERIFIED` marker；每日 retention 只計 marker、簽署及組件均有效且 backup UUID／密文 digest 不重複的備份，損壞或重複備份不會擠走 30 份有效備份。`scrub-backups.sh` 應以較低頻率重新讀取及雜湊全部密文。任何 archive／SQL 錯誤會回滾整次還原，不留下半套 schema 或資料。完成後會核對來源 schema、刪除稽核列數及 target marker。另由教師後台抽查一個已知日期範圍的設計、對戰、排行榜統計和 Excel 匯出，記錄實際 RPO/RTO、操作者、備份檔 checksum 及結果；至少每學期演練一次。

## 自動測試及事故處理

`./infra/backup/test-backup-restore.sh` 會先做 shell 語法及 ShellCheck，然後在臨時 PostgreSQL database 建立 probe、加密備份、還原和驗證，並確認正式模式及同源還原均被拒。CI 缺少 PostgreSQL、age、ShellCheck 或 `TEST_DATABASE_URL` 時會 fail closed；開發機缺少依賴則明確顯示 `SKIP`。

若備份或演練失敗，不要刪除上一份成功備份。先隔離不完整檔案、保存不含秘密的錯誤紀錄並通知系統負責人；若懷疑私鑰或資料庫憑證外洩，立即輪替相應秘密，保留稽核證據，再以已知正常備份在新非正式資料庫驗證。
