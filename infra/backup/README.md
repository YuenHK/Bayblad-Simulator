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
export DELETION_LEDGER_CLI='/opt/steam-top/apps/server/dist/admin/deletion-ledger-cli.js'
export DELETION_SOURCE_INSTANCE_ID='與 restore_control marker 完全相符的 UUID'
export BACKUP_SIGNING_KEY='/離線或秘密管理器掛載/signing-key'
export BACKUP_ALLOWED_SIGNERS_FILE='/受限制位置/allowed_signers'
export BACKUP_SIGNER_ID='steam-top-backup-2026'
./infra/backup/backup.sh
```

腳本先在只讀 repeatable-read transaction 以 `pg_export_snapshot()` 固定快照；刪除稽核列數與 `pg_dump --snapshot` 因而來自完全相同的資料狀態，再把 custom-format dump 串流到 age recipient 加密。每個唯一 staging 目錄內的密文、checksum、manifest、ledger snapshot 及 OpenSSH 簽署會逐一 `fsync`；`COMPLETE` 最後寫入，再原子改名及同步父目錄。只有完整目錄才可還原。manifest 不包含 URL、密碼、學生姓名或篩選內容。

`DELETION_LEDGER_FILE` 是備份目錄以外、`0600` 的外部 append-only tombstone。`P` 同時保存資料庫 instance UUID 與 operation digest；提交後只可追加一次相符的 `C`，已知未執行只可追加一次 `A`。嚴格狀態機會拒絕孤立、重複、錯 digest 或互相衝突的紀錄。備份必須經正式 Node CLI 的 `snapshot` 子命令，在與寫入相同的 PID／OS process-start 鎖下取得一致副本；仍存活的程序即使暫停亦永不被搶鎖。任何未解決的 `P` 會令備份 fail closed；禁止手工追加或修改 ledger。運維人員只能使用用途為 `deletion_reconcile` 的一次性 reauth grant、完全確認字句及授權環境呼叫 CLI `reconcile`；CLI 會核對目前資料庫 instance UUID 及 `deletion_audit`。資料庫不可用、instance 不符或 grant 無效時不會改動 ledger。

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

腳本先驗證檔名、非 symlink、manifest、內嵌 ledger 狀態機與密文 SHA-256，再以 `age --decrypt` 串流至 `pg_restore --single-transaction --clean --if-exists`。每個新備份通過完整驗證後才寫入另外簽署的 `VERIFIED` marker；每日 retention 只計 marker、簽署及組件均有效的備份，損壞備份不會擠走 30 份有效備份。`scrub-backups.sh` 應以較低頻率重新讀取及雜湊全部密文。任何 archive／SQL 錯誤會回滾整次還原，不留下半套 schema 或資料。完成後會核對來源 schema、刪除稽核列數及 target marker。另由教師後台抽查一個已知日期範圍的設計、對戰、排行榜統計和 Excel 匯出，記錄實際 RPO/RTO、操作者、備份檔 checksum 及結果；至少每學期演練一次。

## 自動測試及事故處理

`./infra/backup/test-backup-restore.sh` 會先做 shell 語法及 ShellCheck，然後在臨時 PostgreSQL database 建立 probe、加密備份、還原和驗證，並確認正式模式及同源還原均被拒。CI 缺少 PostgreSQL、age、ShellCheck 或 `TEST_DATABASE_URL` 時會 fail closed；開發機缺少依賴則明確顯示 `SKIP`。

若備份或演練失敗，不要刪除上一份成功備份。先隔離不完整檔案、保存不含秘密的錯誤紀錄並通知系統負責人；若懷疑私鑰或資料庫憑證外洩，立即輪替相應秘密，保留稽核證據，再以已知正常備份在新非正式資料庫驗證。
