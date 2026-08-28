# 公開部署與完整驗收實作計劃

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推薦）或 superpowers:executing-plans 逐任務實現此計劃。步驟使用復選框（`- [ ]`）語法來跟蹤進度。

**目標：** 把已完成平台封裝成可經互聯網 HTTPS 存取的服務，完成安全、負載、備份、iClass、iPad 實機及課程規格驗收。

**架構：** Caddy 終止 TLS 並代理 Vite 靜態資源、Fastify API 和 Socket.IO；web、server、PostgreSQL 分開容器。CI 先跑單元／E2E／安全測試，再建立固定映像；production secrets 只由部署環境注入。

**技術棧：** Docker Compose、Caddy、PostgreSQL、Node.js 24、GitHub Actions 或等效 CI、Playwright、k6／Socket.IO 負載腳本。

---

## 檔案結構

- `Dockerfile.web`：前端 build 及靜態服務映像
- `Dockerfile.server`：Fastify/Socket.IO 映像
- `compose.yaml`：web、server、db、caddy
- `Caddyfile`：HTTPS、API 和 WebSocket 路由
- `.env.example`：必需環境變數名稱
- `.github/workflows/ci.yml`：品質閘門
- `tests/security/`：權限及資料洩露測試
- `tests/load/`：房間、觀賽及統計負載
- `docs/operations/`：部署、還原、iClass 及驗收手冊

### 任務 1：建立 production 容器及環境契約

**文件：**
- 建立：`Dockerfile.web`
- 建立：`Dockerfile.server`
- 建立：`compose.yaml`
- 建立：`.env.example`
- 建立：`apps/server/src/config.ts`
- 測試：`apps/server/src/config.test.ts`

- [ ] **步驟 1：編寫缺少 secret 的失敗測試**

```ts
it.each(["DATABASE_URL", "COOKIE_SIGNING_KEY", "ADMIN_INITIAL_PASSWORD", "WEBCLIP_SIGNING_KEY"])(
  "refuses to boot without %s", key => {
    expect(() => loadConfig(without(process.env, key))).toThrow(key);
  }
);
```

- [ ] **步驟 2：實作 Zod 環境設定**

```ts
const configSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]),
  DATABASE_URL: z.string().url(),
  PUBLIC_ORIGIN: z.string().url(),
  COOKIE_SIGNING_KEY: z.string().min(32),
  ADMIN_USERNAME: z.string().default("admin"),
  ADMIN_INITIAL_PASSWORD: z.string().min(8),
  WEBCLIP_SIGNING_KEY: z.string().min(32)
});
```

`.env.example` 只示範變數名稱；`ADMIN_INITIAL_PASSWORD` 註解說明校方指定值，但不把 production `.env` 提交 Git。

- [ ] **步驟 3：建立多階段 Dockerfile**

兩個映像先 `pnpm fetch`、再 frozen install 及 build；runtime 使用非 root user，只複製 build 產物和 production dependencies。

- [ ] **步驟 4：建立 compose health checks**

PostgreSQL 使用 `pg_isready`；server `/health/ready` 必須驗證資料庫及 migration；web health check 讀取首頁。server 未 ready 前不接受房間連線。

- [ ] **步驟 5：本機 build 及 Commit**

執行：`docker compose build && docker compose config`

預期：映像建立成功，config 不洩露 secret。

```bash
git add Dockerfile.web Dockerfile.server compose.yaml .env.example apps/server/src/config*
git commit -m "chore: containerize simulator services"
```

### 任務 2：Caddy HTTPS、WebSocket 及安全標頭

**文件：**
- 建立：`Caddyfile`
- 建立：`tests/security/headers.spec.ts`

- [ ] **步驟 1：編寫標頭測試**

```ts
test("serves required security headers", async ({ request }) => {
  const response = await request.get("/");
  expect(response.headers()["strict-transport-security"]).toContain("max-age=");
  expect(response.headers()["content-security-policy"]).toContain("default-src 'self'");
  expect(response.headers()["x-content-type-options"]).toBe("nosniff");
});
```

- [ ] **步驟 2：設定路由**

`/api/*` 及 `/socket.io/*` 代理到 server；其他路徑代理 web。保留 WebSocket upgrade，設定請求大小上限及合理 timeout。

- [ ] **步驟 3：設定安全標頭**

加入 HSTS、CSP、`frame-ancestors 'none'`、`nosniff`、嚴格 referrer policy 及 permissions policy。CSP 明確允許本站 WebSocket 和必要的 WebGL，不使用 `unsafe-eval`。

- [ ] **步驟 4：執行測試並 Commit**

執行：`docker compose up -d && pnpm playwright test tests/security/headers.spec.ts`

預期：HTTPS 測試環境全部 PASS，Socket.IO 可升級連線。

```bash
git add Caddyfile tests/security/headers.spec.ts compose.yaml
git commit -m "chore: add https proxy and security headers"
```

### 任務 3：CI 品質閘門及 migration 發佈流程

**文件：**
- 建立：`.github/workflows/ci.yml`
- 建立：`scripts/migrate-and-start.sh`
- 建立：`docs/operations/release.md`

- [ ] **步驟 1：建立 CI job**

CI 使用固定 Node/pnpm 版本，啟動 PostgreSQL service，依次執行：

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm test:e2e
docker compose build
```

- [ ] **步驟 2：建立 migration gate**

`migrate-and-start.sh` 先取得 advisory lock，執行 `drizzle-kit migrate`，確認 schema version 後才啟動 server；migration 失敗須停止發佈，不能在舊 schema 上啟動新程式。

- [ ] **步驟 3：記錄 release／rollback**

手冊要求發佈前加密備份、記錄映像 digest、執行 smoke test；rollback 使用上一個映像，只有相容 migration 才直接退回，否則從發佈前備份還原。

- [ ] **步驟 4：執行 CI workflow 本地等效命令並 Commit**

預期：全部 PASS。

```bash
git add .github scripts docs/operations/release.md
git commit -m "ci: gate tests migrations and container builds"
```

### 任務 4：公開後台安全驗證

**文件：**
- 建立：`tests/security/admin.spec.ts`
- 建立：`tests/security/identity-leak.spec.ts`
- 建立：`docs/operations/security.md`

- [ ] **步驟 1：測試暴力登入及 session**

五次錯誤後同帳號／IP 回傳 429；成功 session 閒置 30 分鐘後失效；Cookie 必須 Secure/HttpOnly/SameSite；登出後舊 cookie 不可重用。

- [ ] **步驟 2：測試學生不能存取管理 API**

未登入及一般學生 session 對 `/api/admin/*`、Excel、刪除、備份、稽核和身份名單全部回傳 401／403。

- [ ] **步驟 3：測試個人資料不洩漏**

URL、HTML、JavaScript bundle、LocalStorage、Socket.IO 學生 payload 不出現學生名單、學號、iClass token、管理密碼或其他玩家 IP。

- [ ] **步驟 4：測試 CSRF 及跨來源**

非 `PUBLIC_ORIGIN` 的 credentialed request 被拒絕；管理 mutation 缺少正確 CSRF token 回傳 403。

- [ ] **步驟 5：執行安全套件並 Commit**

執行：`pnpm playwright test tests/security`

預期：全部 PASS。

```bash
git add tests/security docs/operations/security.md
git commit -m "test: verify public admin and identity security"
```

### 任務 5：即時房間及統計負載測試

**文件：**
- 建立：`tests/load/rooms.mjs`
- 建立：`tests/load/admin-analytics.mjs`
- 建立：`docs/operations/capacity.md`

- [ ] **步驟 1：建立課堂基線情境**

同時 40 名學生建立／加入 20 個房間，另有 100 個觀賽連線。每房只建立一個物理 simulation；訊息延遲 p95 低於 300 ms，錯誤率低於 1%。

- [ ] **步驟 2：建立大量歷史統計情境**

插入 100,000 場 fixture，日／週／月統計 API p95 低於 1 秒，Excel 以 streaming 產生且 server 記憶體不超出容量文件設定上限。

- [ ] **步驟 3：測試保護而非產品上限**

超出訊息速率的單一 client 被限速，不影響同房其他觀賽者；產品介面不顯示固定觀賽人數上限。

- [ ] **步驟 4：記錄容量及 Commit**

執行：`node tests/load/rooms.mjs && node tests/load/admin-analytics.mjs`

預期：達到上述基線；實際測試硬件、CPU、記憶體及結果寫入 `capacity.md`。

```bash
git add tests/load docs/operations/capacity.md
git commit -m "test: establish classroom load capacity"
```

### 任務 6：iClass MDM 技術驗證及 Web Clip 試點

**文件：**
- 建立：`docs/operations/iclass-integration.md`
- 建立：`tests/e2e/iclass-webclip.spec.ts`

- [ ] **步驟 1：向 iClass 確認整合能力**

以書面問題確認：能否按裝置派發個別簽署 URL、是否有 server API、可用裝置識別欄位、token 生命週期及資料使用限制。把實際答覆、日期、聯絡渠道和測試帳號範圍記入文件；不保存真實 secret。

- [ ] **步驟 2：建立測試 Web Clip**

只向一部測試 iPad 派發 `https://<domain>/start?t=<short-lived-signed-token>`，驗證學生毋須輸入資料即可識別；URL 不包含姓名、班別或學號。

- [ ] **步驟 3：測試 iClass 失敗降級**

依次驗證 live iClass、Cookie 快取及訪客；三種狀態均可設計及對戰，教師後台標示正確來源。

- [ ] **步驟 4：Commit 不含憑證的驗證文件及測試**

```bash
git add docs/operations/iclass-integration.md tests/e2e/iclass-webclip.spec.ts
git commit -m "docs: verify iclass web clip identity flow"
```

### 任務 7：iPad／桌面實機及可用性驗收

**文件：**
- 建立：`docs/acceptance/device-matrix.md`
- 建立：`docs/acceptance/manual-checklist.md`

- [ ] **步驟 1：建立實機矩陣**

至少記錄一部學校管理 iPad 的型號、iPadOS、Safari、Web Clip 模式，以及 Mac Safari、桌面 Chrome 和 Edge 版本。

- [ ] **步驟 2：在真實 iPad 完成學生流程**

用觸控完成三層設計、層次重排、3D 旋轉、違規修正、建房、入席、節拍、對戰、轉觀賽、斷線重連及賽後計分。驗證橫向及直向沒有遮擋或過小按鈕。

- [ ] **步驟 3：完成教師流程**

在公開互聯網登入、管理房間、篩選紀錄、查看統計、匯出 Excel、預覽刪除、取消一次刪除，再用測試資料完成一次真正刪除及 audit 驗證。

- [ ] **步驟 4：記錄所有結果**

每項標記 PASS／FAIL、日期、裝置及證據截圖路徑；任何 FAIL 修復後重新執行整個受影響流程。

- [ ] **步驟 5：Commit 驗收紀錄**

```bash
git add docs/acceptance
git commit -m "test: record ipad and desktop acceptance"
```

### 任務 8：最終資料、備份及上線演練

**文件：**
- 建立：`docs/operations/go-live-checklist.md`
- 建立：`docs/operations/privacy-notice-draft.md`

- [ ] **步驟 1：驗證 Excel**

匯出測試資料後重新開啟 `.xlsx`，確認六個工作表、篩選範圍、日期、數值類型及公式數為 0。

- [ ] **步驟 2：演練備份及還原**

由 production-like 資料庫建立加密備份，還原到隔離資料庫，核對 identities、designs、matches、rounds 及 audit 行數。記錄耗時和備份 digest。

- [ ] **步驟 3：準備資料收集告知草稿**

列明收集目的、學生／裝置／IP／對戰欄位、身份失敗訪客安排、教師存取、長期保存、手動刪除、查閱及更正渠道，交由校方正式審批；本步不代替法律審核。

- [ ] **步驟 4：執行最終品質閘門**

執行：

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm test:e2e
pnpm playwright test tests/security
node tests/load/rooms.mjs
docker compose build
```

預期：全部 PASS，實機清單沒有未處理 FAIL，備份還原成功。

- [ ] **步驟 5：Commit**

```bash
git add docs/operations
git commit -m "docs: complete production go-live checks"
```

