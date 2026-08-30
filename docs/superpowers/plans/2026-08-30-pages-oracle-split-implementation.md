# GitHub Pages 與 Oracle 分站部署實作計劃

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推薦）或 superpowers:executing-plans 逐任務實現此計劃。步驟使用復選框（`- [ ]`）語法來跟蹤進度。

**目標：** 將學生前台安全發布至 GitHub Pages，將教師後台、API、WebSocket 及 PostgreSQL 保留在 Oracle A1，並完成可核對的 ARM64 發布鏈。

**架構：** Vite 產生 student 與 admin 兩個靜態輸出；student 以精確 GitHub Pages base path 及 API origin 建置，admin 由 Oracle Caddy 同源提供。Fastify 分別執行 student origin 與 admin origin 政策，學生以不透明 bearer 會話工作，管理員保留 HttpOnly 同源 Cookie。

**技術棧：** TypeScript、React、Vite、Fastify、Socket.IO、PostgreSQL、Docker Buildx、GitHub Actions、GitHub Pages、Caddy、DuckDNS。

---

## 檔案結構

- `scripts/verify-multiarch-image.mjs`：核對 metadata digest、OCI index、平台 attestation subject、SLSA 及 SPDX，輸出規範化證據。
- `tests/ci/multiarch-image.test.ts`：真實 Buildx 形狀的正反例矩陣。
- `.github/workflows/ci.yml`：以 metadata 不可變 digest 取回證據，封存後發布 Pages 與 ARM64 影像。
- `apps/web/vite.config.ts`：固定 student/admin build mode、Pages base path 及 API origin。
- `apps/web/src/main.tsx`：以建置模式選擇 student 或 admin 入口，不以 URL query 切換權限。
- `apps/web/src/realtime/student-credential.ts`：儲存、驗證及清除不透明學生憑證。
- `apps/web/src/realtime/socket-client.ts`：以 bearer 建立 identity HTTP 及 Socket.IO 連線。
- `apps/server/src/config.ts`：分開 `PUBLIC_ORIGIN` 與 `STUDENT_ORIGIN`，保證皆為精確 HTTPS origin。
- `apps/server/src/identity/student-credential.ts`：簽發、核對、過期及輪換學生 bearer。
- `apps/server/src/identity/routes.test.ts`、`socket-identity.test.ts`：跨站 bearer、Origin 及 replay 邊界測試。
- `Caddyfile`、`Dockerfile.web`：Oracle 只服務 admin 靜態輸出及 API/WSS。
- `.github/workflows/pages.yml`：審核後建置及發布 GitHub Pages student artifact。
- `docs/operations/oracle-a1-duckdns.md`：建機、DuckDNS、防火牆、secrets、部署及驗收操作手冊。

### 任務 1：封閉 ARM64 發布證據缺口

**檔案：**
- 修改：`scripts/verify-multiarch-image.mjs`
- 修改：`tests/ci/multiarch-image.test.ts`
- 修改：`tests/ci/release-contract.test.ts`
- 修改：`.github/workflows/ci.yml`

- [ ] **步驟 1：寫入失敗測試**

建立包含 OCI index、amd64/arm64 application descriptor、對應 attestation manifest、SLSA predicate 與 SPDX document 的 fixture。證明以下輸入必須失敗：metadata/index digest 不同、subject 不同、只有 SBOM、錯誤 commit、重複平台、額外平台、重複 predicate。

- [ ] **步驟 2：確認紅燈**

`pnpm vitest run tests/ci/multiarch-image.test.ts tests/ci/release-contract.test.ts`

預期：新證據介面尚未實作而 FAIL。

- [ ] **步驟 3：實作最小核對器**

CLI 固定為：

```text
node scripts/verify-multiarch-image.mjs METADATA RAW_INDEX AMD64_ATTEST AMD64_PROVENANCE AMD64_SBOM ARM64_ATTEST ARM64_PROVENANCE ARM64_SBOM EXPECTED_COMMIT OUTPUT
```

對 `RAW_INDEX` 原始 bytes 計算 SHA-256，必須等於 `containerimage.digest`；輸出只包含 root digest、兩個 application digest 及已核對 predicate 類型的 canonical JSON。

- [ ] **步驟 4：改用不可變 reference**

工作流程從 metadata 取得 digest，只對 `repository@sha256:...` 執行 `imagetools inspect`；逐平台擷取 attestation manifest、`.Provenance` 與 `.SBOM`，將證據納入 `SHA256SUMS` 並獨立 attestation。

- [ ] **步驟 5：確認綠燈並提交**

`pnpm vitest run tests/ci`

預期：所有 CI contract 測試通過。

Commit：`fix(ci): bind multiarch release evidence`

### 任務 2：產生不可混用的 student/admin 輸出

**檔案：**
- 修改：`apps/web/vite.config.ts`
- 修改：`apps/web/src/main.tsx`
- 新增：`apps/web/src/build-contract.test.ts`
- 修改：`apps/web/package.json`

- [ ] **步驟 1：寫入建置 contract 失敗測試**

斷言 student 建置必須具備 `/repository/` base 及 HTTPS API origin，admin 建置必須使用 `/admin/` 及同源 API；任一值缺失、含 query/fragment 或使用 HTTP 都失敗。

- [ ] **步驟 2：實作固定 build mode**

`STEAM_TOP_WEB_TARGET=student|admin`、`STEAM_TOP_PAGES_BASE=/<repository>/`、`VITE_API_BASE_URL=https://<duckdns-name>` 由 CI 注入。`main.tsx` 只根據建置常數選擇 `App` 或 `AdminApp`。

- [ ] **步驟 3：建置兩個 artifact 並檢查邊界**

```bash
pnpm --filter @steam-top/web build:student
pnpm --filter @steam-top/web build:admin
```

預期：student artifact 不包含 admin 入口 chunk；admin artifact 不顯示學生大廳。

- [ ] **步驟 4：提交**

Commit：`feat(web): split student and admin builds`

### 任務 3：建立跨站學生憑證

**檔案：**
- 新增：`apps/server/src/identity/student-credential.ts`
- 新增：`apps/server/src/identity/student-credential.test.ts`
- 修改：`apps/server/src/app.ts`
- 修改：`apps/server/src/socket.ts`
- 修改：`apps/server/src/config.ts`
- 修改：`apps/server/src/production-entry.ts`

- [ ] **步驟 1：寫入憑證失敗測試**

測試憑證只含隨機 token id、identity id、issued-at、expiry 及 key id；拒絕過期、簽章錯誤、不同 origin、不同 audience、超長輸入及已輪換 key。

- [ ] **步驟 2：實作 `StudentCredentialService`**

```ts
type StudentCredentialClaims = Readonly<{
  tokenId: string; identityId: string; issuedAt: number; expiresAt: number;
}>;
```

使用 HMAC-SHA-256 及 canonical base64url，預設壽命 12 小時，驗證時使用 constant-time comparison。

- [ ] **步驟 3：分開 origin 政策**

`PUBLIC_ORIGIN` 為 Oracle admin origin，`STUDENT_ORIGIN` 為 GitHub Pages origin。管理員 route 只允許前者；identity、design 及 Socket.IO 只允許已列白名單的 student/admin origin。

- [ ] **步驟 4：驗證 HTTP 及 WebSocket**

`pnpm --filter @steam-top/server test -- student-credential socket-identity routes`

預期：允許 origin 以 bearer 成功；伪造 origin 及只有 Cookie 的跨站請求失敗。

- [ ] **步驟 5：提交**

Commit：`feat(server): authorize split-site student sessions`

### 任務 4：改造學生用戶端 bootstrap

**檔案：**
- 新增：`apps/web/src/realtime/student-credential.ts`
- 新增：`apps/web/src/realtime/student-credential.test.ts`
- 修改：`apps/web/src/realtime/socket-client.ts`
- 修改：`apps/web/src/realtime/socket-client.test.ts`

- [ ] **步驟 1：寫入儲存及重連失敗測試**

斷言只儲存 opaque credential，不儲存 identity response、display name、class 或 student number；401 時清除舊憑證並只重試一次。

- [ ] **步驟 2：實作 bearer bootstrap**

`GET /api/identity` 改為必要時建立 guest，並回傳 credential；後續請求使用 `Authorization: Bearer ...`，Socket.IO `auth.studentCredential` 使用同一值。

- [ ] **步驟 3：確認中止、造次及離線邊界**

`pnpm --filter @steam-top/web test -- socket-client student-credential safe-storage`

預期：所有 timeout、AbortSignal、session replacement 及 design upload 測試通過。

- [ ] **步驟 4：提交**

Commit：`feat(web): bootstrap students across Pages origin`

### 任務 5：發布 GitHub Pages 及 Oracle admin web

**檔案：**
- 新增：`.github/workflows/pages.yml`
- 修改：`Dockerfile.web`
- 修改：`Caddyfile`
- 修改：`tests/ci/release-contract.test.ts`
- 修改：`tests/security/production-security.test.ts`

- [ ] **步驟 1：寫入工作流程 contract**

必須使用固定 commit SHA 的 checkout、configure-pages、upload-pages-artifact 及 deploy-pages action；權限只包含 `contents: read`、`pages: write`、`id-token: write`，部署 environment 為 `github-pages`。

- [ ] **步驟 2：建置 Pages artifact**

使用 repository name 建立 base path，在 artifact 中寫入靜態 CSP 和 404 fallback；檢查產物不包含 source map、secret 或 admin chunk。

- [ ] **步驟 3：改為 Oracle admin image**

`Dockerfile.web` 只複製 admin build；Caddy `/admin/*` 提供 admin SPA，`/api/*`、`/socket.io/*` 反向代理 server，根路不再提供學生 app。

- [ ] **步驟 4：執行安全測試並提交**

`pnpm test:security`

Commit：`feat(deploy): publish Pages student frontend`

### 任務 6：DuckDNS 與 Oracle A1 作業準備

**檔案：**
- 新增：`docs/operations/oracle-a1-duckdns.md`
- 新增：`infra/oracle/update-duckdns.sh`
- 新增：`infra/oracle/steam-top-duckdns.service`
- 新增：`infra/oracle/steam-top-duckdns.timer`
- 修改：`scripts/validate-deployment-env.mjs`
- 新增：`tests/ci/duckdns-contract.test.ts`

- [ ] **步驟 1：寫入 fail-closed DuckDNS 測試**

拒絕非 `*.duckdns.org`、HTTP update URL、非 root-owned 0600 token file、無效 IPv4、非 `OK` 回應及將 token 寫入 argv/log 的實作。

- [ ] **步驟 2：實作 systemd timer**

更新器從 `/run/secrets/duckdns_token` 讀取 token，以 stdin/config 避免出現在行程列表，成功後只記錄 hostname 與時間。

- [ ] **步驟 3：寫完全操作手冊**

記錄 Singapore home region、`VM.Standard.A1.Flex` 2 OCPU/12 GB、Ubuntu 24.04 ARM64、保留 IP、VCN/iptables 22/80/443、volume、GitHub packages login、DuckDNS、Caddy TLS、backup 及 smoke test 精確命令。

- [ ] **步驟 4：提交**

Commit：`docs(deploy): prepare Oracle A1 and DuckDNS host`

### 任務 7：全面驗證及帳戶邊界

**檔案：**
- 修改：`docs/operations/release.md`
- 修改：`docs/operations/oracle-a1-duckdns.md`

- [ ] **步驟 1：執行本機全面測試**

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

預期：所有可在 macOS 執行的測試通過。PostgreSQL、Docker multiarch 及生產 E2E 由 Ubuntu GitHub runner 執行。

- [ ] **步驟 2：執行變更審查**

`git diff --check` 無輸出；核對無 secret、無可變 image tag、無 wildcard CORS、無跨站 admin Cookie。

- [ ] **步驟 3：停在必需帳戶輸入邊界**

未登入 GitHub 時，不建立 repository、Pages environment、secrets 或發佈 image。未登入 Oracle/DuckDNS 時，不建機或發布。報告已完成的 commit、本機測試證據，以及下一個唯一的帳戶步驟。
