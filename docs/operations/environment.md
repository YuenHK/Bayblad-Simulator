# 正式環境設定

1. 複製 `.env.example` 為 `.env`；`.env` 已被 Git 忽略。
2. 為 Node、PostgreSQL、Caddy 分別填寫 `*_IMAGE_REPOSITORY` 及由 CI 核實的 `*_IMAGE_DIGEST=sha256:<64 hex>`。Dockerfile／Compose 會直接組成 `repository@digest`；不可自行猜測 digest。
3. 下列值各自用 `openssl rand -base64 48 | tr '+/' '-_' | tr -d '='` 產生：`COOKIE_SIGNING_KEY`、`ADMIN_CSRF_SECRET`、`WEBCLIP_SIGNING_KEY`、`WEBCLIP_EXCHANGE_KEY`、`ANALYTICS_CURSOR_SECRET`。五個值不得重複。
4. 正式教師控制台現使用共用口令 `admin`；`ADMIN_USERNAME`／`ADMIN_INITIAL_PASSWORD` 不再供登入或啟動使用。保留舊帳號資料但不覆寫密碼。獨立簽章／CSRF 密鑰仍必須保密。舊主機的 smoke 輸入檔須改為 `{"passphrase":"admin"}`；檔案的 root 所有權／權限驗證仍保留。
5. `POSTGRES_TLS_CERT_PATH`／`POSTGRES_TLS_KEY_PATH` 指向主機上的獨立 TLS 證書及私鑰；`DATABASE_URL` 必須連到 Compose 的 `db` 服務並使用相同帳密。
6. 執行 `node scripts/validate-deployment-env.mjs .env`，成功後才可執行 `docker compose --env-file .env config`／`build`／`up`。

iClass 使用 `guest-only-explicit` 時不讀 API／CSV。`api` 需要 HTTPS API URL 及 bearer token；`csv` 使用唯讀掛載到 `/app/config/iclass-device-map.csv` 的檔案；fallback 模式兩者都必須齊備。
