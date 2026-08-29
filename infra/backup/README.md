# 加密備份及還原手冊

正式紀錄預設永久保留，系統不會按年齡自動刪除資料。這裡的 30 份限制只適用於每日加密備份檔；學生紀錄只能經教師後台的預覽、重新驗證、精確確認及不可變刪除稽核流程移除。

## 服務目標

- RPO（可接受資料損失）：每日備份時為 24 小時。若學校需要更低 RPO，應增加受監察的備份頻率，而不是減少保留份數。
- RTO（目標恢復時間）：4 小時，包括取得離線 age 私鑰、建立全新非正式驗證資料庫、還原、核對 schema／列數及由負責人批准切換。
- 每日至少保留最近 30 份完整備份。`backup.sh` 只會清理名稱完全符合 `steam-top-YYYYMMDDTHHMMSSZ-NNNNNN.dump.age` 的普通檔案及其同名 metadata；不會遞迴刪除目錄。

## 建立備份

備份主機需要 PostgreSQL client、`age` 和 SHA-256 工具。備份目錄必須位於受限制的持久磁碟；腳本會建立 `0700` 目錄及 `0600` 檔案。

```bash
export DATABASE_URL='由秘密管理器注入，不要寫入指令紀錄或檔案'
export BACKUP_DIR='/srv/steam-top/backups'
export AGE_RECIPIENT='age1...'
./infra/backup/backup.sh
```

腳本以 custom-format `pg_dump` 串流到 age recipient 加密，完成後才原子改名；旁邊的 `.sha256` 與 `.manifest` 記錄密文 checksum、來源資料庫名稱、schema 和一個驗證表的精確列數，不包含 URL、密碼、學生姓名或紀錄內容。排程器應每日執行一次，只有三個完整檔案都存在才視為成功，並對失敗發出告警。

## 私鑰及輪替

age identity 私鑰不可放在程式庫、備份目錄或同一台資料庫主機。最少保留一份離線／受權限管理副本，並記錄可存取人員。每學年或任何疑似外洩後建立新 recipient：先把 `AGE_RECIPIENT` 改為新公鑰並完成一次還原演練；舊私鑰必須保留至以該鑰匙加密的最後一份備份逾期，才可按學校密鑰銷毀程序移除。

## 還原演練

還原只接受明確的一個加密檔案。目標資料庫必須已存在、名稱清楚包含 `test`、`restore`、`staging` 或 `drill`，不得與 manifest 的來源資料庫相同；`APP_ENV=production` 或 `NODE_ENV=production` 會直接拒絕。目標確認字串必須完全等於實際連線的 database name。

```bash
export RESTORE_DATABASE_URL='由秘密管理器注入的全新非正式資料庫'
export RESTORE_CONFIRM_DATABASE='steam_top_restore_20260829'
export AGE_IDENTITY_FILE='/受限制位置/steam-top-age-key.txt'
./infra/backup/restore.sh /srv/steam-top/backups/steam-top-20260829T010000Z-123456.dump.age
```

腳本先驗證檔名、非 symlink、manifest 與密文 SHA-256，再以 `age --decrypt` 串流至 `pg_restore --clean --if-exists`。所以目標必須是專為演練建立、可被覆寫的非正式資料庫。完成後會核對來源 schema 存在及驗證表列數。另由教師後台抽查一個已知日期範圍的設計、對戰、排行榜統計和 Excel 匯出，記錄實際 RPO/RTO、操作者、備份檔 checksum 及結果；至少每學期演練一次。

## 自動測試及事故處理

`./infra/backup/test-backup-restore.sh` 會先做 shell 語法及 ShellCheck，然後在臨時 PostgreSQL database 建立 probe、加密備份、還原和驗證，並確認正式模式及同源還原均被拒。CI 缺少 PostgreSQL、age、ShellCheck 或 `TEST_DATABASE_URL` 時會 fail closed；開發機缺少依賴則明確顯示 `SKIP`。

若備份或演練失敗，不要刪除上一份成功備份。先隔離不完整檔案、保存不含秘密的錯誤紀錄並通知系統負責人；若懷疑私鑰或資料庫憑證外洩，立即輪替相應秘密，保留稽核證據，再以已知正常備份在新非正式資料庫驗證。
