# 身份、教師後台與統計實作計劃

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推薦）或 superpowers:executing-plans 逐任務實現此計劃。步驟使用復選框（`- [ ]`）語法來跟蹤進度。

**目標：** 保存學生／訪客設計與對戰資料，加入 iClass 整合接口、安全 Cookie 備援、教師管理、統計、Excel、手動刪除及備份。

**架構：** PostgreSQL/Drizzle 是權威持久層；identity adapter 隔離 iClass 外部依賴並提供簽署 Web Clip、Cookie 快取及訪客三條路徑。教師 API 由獨立 session guard 保護，統計和 Excel 只讀取已提交紀錄。

**技術棧：** PostgreSQL、Drizzle ORM、Fastify 5、Zod 4、`@node-rs/argon2` 2、ExcelJS 4、Recharts 3、Vitest 4、Playwright 1。

---

## 檔案結構

- `packages/db/src/schema.ts`：資料表及關聯
- `apps/server/src/identity/`：iClass、Cookie、訪客及身份合併
- `apps/server/src/auth/`：教師登入和 session
- `apps/server/src/records/`：設計、逐輪及對戰持久化
- `apps/server/src/analytics/`：使用量及參數統計
- `apps/server/src/exports/`：Excel 產生器
- `apps/server/src/admin/`：房間管理、刪除及稽核 API
- `apps/web/src/features/admin/`：教師後台
- `infra/backup/`：加密備份與還原腳本

### 任務 1：建立 PostgreSQL schema 及 migration

**文件：**
- 建立：`packages/db/package.json`
- 建立：`packages/db/src/schema.ts`
- 建立：`packages/db/src/client.ts`
- 建立：`drizzle.config.ts`
- 測試：`packages/db/src/schema.test.ts`

- [ ] **步驟 1：建立 db package manifest**

```json
{
  "name": "@steam-top/db", "private": true, "type": "module",
  "exports": { ".": "./src/client.ts", "./schema": "./src/schema.ts" },
  "scripts": { "test": "vitest run", "typecheck": "tsc --noEmit", "build": "tsc --noEmit", "lint": "tsc --noEmit" },
  "dependencies": { "drizzle-orm": "0.45.2", "postgres": "3.4.9" },
  "devDependencies": { "drizzle-kit": "0.31.10", "typescript": "7.0.2", "vitest": "4.1.11" }
}
```

執行：`pnpm install`

- [ ] **步驟 2：編寫 schema 約束測試**

```ts
it("stores a match with rounds, two designs and identities", async () => {
  const match = await fixtures.insertCompletedMatch(db);
  expect(await queries.matchWithDetails(db, match.id)).toMatchObject({
    rounds: expect.arrayContaining([expect.objectContaining({ launchGradeA: "Perfect" })])
  });
});
```

- [ ] **步驟 3：執行確認失敗**

執行：`pnpm --filter @steam-top/db test`

預期：FAIL，schema 未建立。

- [ ] **步驟 4：建立資料表**

```ts
export const identities = pgTable("identities", {
  id: uuid("id").primaryKey().defaultRandom(),
  status: text("status", { enum: ["iclass", "cookie", "guest"] }).notNull(),
  displayName: text("display_name").notNull(),
  studentName: text("student_name"), className: text("class_name"), studentNumber: text("student_number"),
  deviceName: text("device_name"), anonymousDeviceId: uuid("anonymous_device_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
});
```

同檔案建立 `designs`、`designLayers`、`matches`、`rounds`、`rooms`、`sessions`、`adminAudit` 及 `deletionAudit`。IP 使用 `inet`；設計及物理模型版本不可為空。

- [ ] **步驟 5：產生 migration 及執行整合測試**

執行：`pnpm --filter @steam-top/db exec drizzle-kit generate && pnpm --filter @steam-top/db test`

預期：migration 可在空測試資料庫套用，schema 測試 PASS。

- [ ] **步驟 6：Commit**

```bash
git add packages/db drizzle.config.ts drizzle pnpm-lock.yaml
git commit -m "feat: add persistent simulator data model"
```

### 任務 2：訪客身份及安全 Cookie 快取（已完成）

**文件：**
- 建立：`apps/server/src/identity/guest.ts`
- 建立：`apps/server/src/identity/cookie.ts`
- 測試：`apps/server/src/identity/cookie.test.ts`

- [x] **步驟 1：編寫身份優先次序測試**

```ts
it("prefers live iClass over cached cookie and guest", async () => {
  const identity = await resolveIdentity({ liveToken, cookieToken, request });
  expect(identity.status).toBe("iclass");
});

it("creates 訪客-四位碼 without a trusted token", async () => {
  const identity = await resolveIdentity({ request });
  expect(identity).toMatchObject({ status: "guest", displayName: expect.stringMatching(/^訪客-[A-F0-9]{4}$/) });
});
```

- [x] **步驟 2：執行確認失敗**

執行：`pnpm --filter @steam-top/server test -- identity/cookie.test.ts`

預期：FAIL，resolver 未建立。

- [x] **步驟 3：實作 opaque session cookie**

Cookie 只保存 256-bit 隨機 token；資料庫保存 token 的 SHA-256 hash、identity id、建立及最後使用時間。設定 `Secure`、`HttpOnly`、`SameSite=Strict`、根路徑及固定過期策略；不保存姓名、班別或學號。

- [x] **步驟 4：實作訪客重用及 IP 診斷欄位**

相同有效匿名 Cookie 重用訪客代碼；IP 和 user-agent 只加入事件紀錄，不作身份主鍵。

- [x] **步驟 5：測試並 Commit**

執行：`pnpm --filter @steam-top/server test -- identity`

預期：iClass、Cookie、訪客優先次序和 cookie flags 測試 PASS。

```bash
git add apps/server/src/identity
git commit -m "feat: resolve cached and guest identities safely"
```

實作決策：身份 Cookie 採 256-bit opaque token、資料庫只存 SHA-256 hash；每次有效使用把期限滾動至 180 日後，`Max-Age` 與 `Expires` 以整秒一致。回傳 `status` 表示本次辨識來源：即時可信身份為 `iclass`、已驗證身份的 Cookie 重播為 `cookie`、匿名訪客及其 Cookie 重播為 `guest`；學生敏感欄位只留在伺服器及教師後台，公共 DTO 只含 id、status、displayName。四位訪客碼只是可重複顯示名稱，身份以 UUID／participantId 區分。查詢 session 不延長期限，只有最終採用 Cookie 後才 touch；live 身份一律原子換發新 token，訪客升級時同一交易撤銷舊 token 並建立身份連結。IP／user-agent 僅是診斷欄位；代理環境必須注入獨立可信 IP resolver。無效／無 Cookie 的身份建立受有界每客戶及全域 token bucket 與 store capacity 保護。正式環境只接受實際 PostgresIdentityStore，記憶體 adapter 只供測試。Socket.IO 將於 iClass adapter／即時整合任務改為由 HttpOnly Cookie resolver 供應 displayName，現階段不接受 client JSON 作 live 身份。

威脅及容量說明：瀏覽器送出不在 allowlist 的 Origin 或 `Sec-Fetch-Site: cross-site` 會在任何寫入前被拒；缺少這兩個 header 則刻意容許受管理 Web Clip、CLI 及非瀏覽器客戶端，並由建立限流與容量上限防濫用。每個可信 client key 預設可突發 600 個新身份、其後每秒只補 0.01 個；全平台可突發 5,000 個、每秒補 0.1 個。以單校 NAT 計算，600 部同時首次進站可全數通過，第 601 個需等待約 100 秒；有效 Cookie 重用不扣建立額度。Postgres 只把 `revoked_at is null and expires_at > now` 計入 auth capacity，並以 `revoked_at is null` partial index配合到期時間查詢；已撤銷／到期 session 可永久保留作稽核，`archivedAt` 標示已撤銷封存，絕不再作驗證容量。未來清理只可刪除或不可逆遮蔽 token hash 等驗證材料，必須保留獲授權的診斷／稽核紀錄，不會自動刪除永久紀錄。Task 3 正式組裝只接受經簽署 Web Clip 或可信 API adapter 的輸出；禁止以 request body、query 或 client JSON 建立 live identity provider。

### 任務 3：iClass Web Clip 整合接口

**文件：**
- 建立：`apps/server/src/identity/iclass-adapter.ts`
- 建立：`apps/server/src/identity/webclip-token.ts`
- 建立：`apps/server/src/identity/import-device-map.ts`
- 測試：`apps/server/src/identity/iclass-adapter.test.ts`

- [ ] **步驟 1：編寫簽署 token 測試**

```ts
it("accepts a valid device token once", async () => {
  const token = signWebClipToken({ deviceId: "ipad-001", expiresAt: now + 300_000 }, secret);
  expect(await adapter.resolve(token)).toMatchObject({ studentName: "陳同學", className: "1A" });
  await expect(adapter.resolve(tamper(token))).rejects.toThrow("INVALID_DEVICE_TOKEN");
});
```

- [ ] **步驟 2：執行確認失敗**

執行：`pnpm --filter @steam-top/server test -- iclass-adapter.test.ts`

預期：FAIL，adapter 未建立。

- [ ] **步驟 3：定義 adapter 接口**

```ts
export interface IClassAdapter {
  resolveSignedDeviceToken(token: string): Promise<{
    externalDeviceId: string; deviceName: string; studentName: string; className: string; studentNumber: string;
  } | null>;
}
```

提供 `ApiIClassAdapter` 和 `ImportedDeviceMapAdapter`。API URL／憑證只從環境變數讀取；若 iClass 尚未提供 API，CSV 匯入欄位固定為 `externalDeviceId,deviceName,studentName,className,studentNumber`。

- [ ] **步驟 4：實作身份升級而不誤合併**

只有同一安全 Cookie 和已驗證 signed device token 同時出現時，才把該匿名裝置舊紀錄連到 iClass identity；不以 IP、user-agent 或相似姓名合併。

- [ ] **步驟 5：測試並 Commit**

執行：`pnpm --filter @steam-top/server test -- identity`

預期：有效、過期、篡改、API 失敗、CSV fallback 及安全合併全部 PASS。

```bash
git add apps/server/src/identity
git commit -m "feat: add iclass web clip identity adapter"
```

### 任務 4：教師登入及權限守衛

**文件：**
- 建立：`apps/server/src/auth/admin-auth.ts`
- 建立：`apps/server/src/auth/admin-session.ts`
- 建立：`apps/server/src/auth/rate-limit.ts`
- 測試：`apps/server/src/auth/admin-auth.test.ts`

先執行：`pnpm --filter @steam-top/server add @node-rs/argon2@2.1.0 @fastify/cookie@11.1.2 @fastify/csrf-protection@8.0.1`

- [ ] **步驟 1：編寫登入測試**

```ts
it("logs in with configured admin credentials", async () => {
  const response = await app.inject({ method: "POST", url: "/api/admin/login", payload: { username: "admin", password: "fwft2026" } });
  expect(response.statusCode).toBe(204);
  expect(response.cookies[0]).toMatchObject({ httpOnly: true, secure: true, sameSite: "Strict" });
});

it("locks repeated failures", async () => {
  for (let i = 0; i < 5; i++) await badLogin(app);
  expect((await badLogin(app)).statusCode).toBe(429);
});
```

- [ ] **步驟 2：執行確認失敗**

執行：`pnpm --filter @steam-top/server test -- admin-auth.test.ts`

預期：FAIL，登入 route 未建立。

- [ ] **步驟 3：實作 Argon2id 驗證**

啟動時若資料庫沒有 admin，從 `ADMIN_USERNAME` 和 `ADMIN_INITIAL_PASSWORD` 建立 Argon2id hash；部署預設值由 `.env.example` 文件說明，但實際密碼只在環境變數注入。

- [ ] **步驟 4：加入 session、CSRF、閒置登出及 audit**

管理 API 需同時通過 session 和 CSRF header；session 閒置 30 分鐘失效。登入成功／失敗、IP、時間和動作寫入 `adminAudit`。

- [ ] **步驟 5：測試並 Commit**

執行：`pnpm --filter @steam-top/server test -- auth`

預期：正確登入、錯誤延遲、五次鎖定、session 過期和 CSRF 測試 PASS。

```bash
git add apps/server/src/auth
git commit -m "feat: secure public admin login"
```

### 任務 5：設計、逐輪及賽果持久化

**文件：**
- 建立：`apps/server/src/records/design-repository.ts`
- 建立：`apps/server/src/records/match-repository.ts`
- 測試：`apps/server/src/records/match-repository.test.ts`

- [ ] **步驟 1：編寫原子提交測試**

```ts
it("writes match, rounds and scores in one transaction", async () => {
  await repository.saveCompletedMatch(fixtureMatch);
  expect(await db.select().from(matches)).toHaveLength(1);
  expect(await db.select().from(rounds)).toHaveLength(fixtureMatch.rounds.length);
});
```

- [ ] **步驟 2：執行確認失敗**

執行：`pnpm --filter @steam-top/server test -- match-repository.test.ts`

預期：FAIL，repository 未建立。

- [ ] **步驟 3：實作 transaction 及冪等 match id**

同一 match id 第二次保存回傳既有紀錄，不重複 rounds 或分數。保存雙方設計完整快照、性能模型版本、物理版本、seed、發射判定、IP、裝置類型及觀賽人數。

- [ ] **步驟 4：連接即時伺服器 match.finished**

只有 repository transaction 成功後才廣播正式賽後分數；失敗則該場標記保存失敗並讓教師重試，不產生半套資料。

- [ ] **步驟 5：測試並 Commit**

執行：`pnpm --filter @steam-top/server test -- records`

預期：成功、重複、transaction rollback 全部 PASS。

```bash
git add apps/server/src/records apps/server/src/socket.ts
git commit -m "feat: persist designs rounds and match results"
```

### 任務 6：使用量及參數統計

**文件：**
- 建立：`apps/server/src/analytics/usage.ts`
- 建立：`apps/server/src/analytics/parameters.ts`
- 建立：`apps/server/src/analytics/queries.test.ts`

- [ ] **步驟 1：建立固定資料集測試**

插入跨兩日、兩週、兩月的 fixtures，斷言 active devices 去重、設計次數、房間數、對戰場數及形狀比例。

- [ ] **步驟 2：編寫高低表現門檻測試**

```ts
it("excludes parameter groups below ten completed matches", async () => {
  const rows = await parameterPerformance(db, fixtureRange);
  expect(rows.some(row => row.sampleSize < 10)).toBe(false);
});
```

- [ ] **步驟 3：實作 SQL 聚合及快取表**

每日背景工作更新 materialized summary；API 可按日期、班別、身份狀態及模型版本篩選。輸出平均分、勝率、樣本數、發射判定分布及對手平均強度。

- [ ] **步驟 4：測試並 Commit**

執行：`pnpm --filter @steam-top/server test -- analytics`

預期：全部已知 fixture 統計相符。

```bash
git add apps/server/src/analytics packages/db
git commit -m "feat: aggregate usage and parameter performance"
```

### 任務 7：Excel 匯出

**文件：**
- 建立：`apps/server/src/exports/workbook.ts`
- 測試：`apps/server/src/exports/workbook.test.ts`

先執行：`pnpm --filter @steam-top/server add exceljs@4.4.0`

- [ ] **步驟 1：編寫 workbook 結構測試**

```ts
it("exports all required worksheets", async () => {
  const workbook = await buildWorkbook(db, filters);
  expect(workbook.worksheets.map(sheet => sheet.name)).toEqual([
    "對戰紀錄", "逐輪結果", "陀螺參數", "身份及裝置狀態", "使用量統計", "參數分析"
  ]);
});
```

- [ ] **步驟 2：執行確認失敗**

執行：`pnpm --filter @steam-top/server test -- workbook.test.ts`

預期：FAIL，exporter 未建立。

- [ ] **步驟 3：實作 ExcelJS streaming workbook**

每張工作表使用固定欄名、凍結首列、自動篩選、ISO 日期和數值 cell；首頁 metadata 列明產生時間、日期範圍及模型版本。不得把公式寫入匯出檔。

- [ ] **步驟 4：重新開啟驗證**

測試以 ExcelJS 重新讀取 buffer，檢查工作表、列數、數值類型及公式數為 0。

- [ ] **步驟 5：測試並 Commit**

執行：`pnpm --filter @steam-top/server test -- exports`

預期：全部 PASS。

```bash
git add apps/server/src/exports
git commit -m "feat: export teacher records to excel"
```

### 任務 8：手動刪除、稽核及備份

**文件：**
- 建立：`apps/server/src/admin/delete-records.ts`
- 建立：`apps/server/src/admin/delete-records.test.ts`
- 建立：`infra/backup/backup.sh`
- 建立：`infra/backup/restore.sh`
- 建立：`infra/backup/test-backup-restore.sh`
- 建立：`infra/backup/README.md`

- [ ] **步驟 1：編寫重新驗證及刪除測試**

刪除 API 缺少當次密碼或 confirmation phrase 時回傳 403；正確時 transaction 刪除 identity 關聯個資並保留不含內容的 `deletionAudit`。

- [ ] **步驟 2：實作按學生、班別、日期及全部範圍**

API 先回傳 preview count，再要求相同 filter hash、管理員密碼和 `DELETE` 確認字串；避免畫面變化造成刪錯範圍。

- [ ] **步驟 3：實作加密滾動備份**

`backup.sh` 使用 `pg_dump --format=custom` 後以 age recipient 加密；保留 30 份每日備份。`restore.sh` 只接受明確檔案路徑，還原到指定非 production 資料庫作驗證。

- [ ] **步驟 4：測試刪除及還原**

執行：`pnpm --filter @steam-top/server test -- delete-records.test.ts && ./infra/backup/test-backup-restore.sh`

預期：刪除後一般查詢和匯出找不到資料；備份測試資料庫可還原。

- [ ] **步驟 5：Commit**

```bash
git add apps/server/src/admin infra/backup
git commit -m "feat: add audited deletion and encrypted backups"
```

### 任務 9：教師後台 UI 及 E2E

**文件：**
- 建立：`apps/web/src/features/admin/AdminLogin.tsx`
- 建立：`apps/web/src/features/admin/AdminDashboard.tsx`
- 建立：`apps/web/src/features/admin/RoomsPanel.tsx`
- 建立：`apps/web/src/features/admin/RecordsTable.tsx`
- 建立：`apps/web/src/features/admin/AnalyticsCharts.tsx`
- 建立：`apps/web/src/features/admin/DeleteDialog.tsx`
- 建立：`tests/e2e/admin.spec.ts`

先執行：`pnpm --filter @steam-top/web add recharts@3.10.1`

- [ ] **步驟 1：編寫未登入阻擋及登入 E2E**

直接進入 `/admin` 會轉到登入頁；輸入環境提供的測試帳密後顯示總覽，不在 URL 或 LocalStorage 出現密碼。

- [ ] **步驟 2：實作即時房間管理**

房間表顯示玩家、觀賽人數、狀態；提供暫停平台、強制關房及移除使用者，全部要求確認並寫 audit。

- [ ] **步驟 3：實作紀錄、統計及匯出**

表格支援日期、班別、身份、裝置和參數篩選；圖表顯示日／週／月用量、參數比例、平均分、勝率及樣本數。「目前最高平均表現參數」只顯示 sample >= 10。

- [ ] **步驟 4：實作二次確認刪除 UI**

先顯示 preview count，再要求管理員密碼及 `DELETE`；成功後刷新統計，不在前端保留已刪資料。

- [ ] **步驟 5：執行階段品質閘門**

執行：`pnpm lint && pnpm typecheck && pnpm test && pnpm test:e2e -- tests/e2e/admin.spec.ts`

預期：全部 PASS。

- [ ] **步驟 6：Commit**

```bash
git add apps/web/src/features/admin tests/e2e/admin.spec.ts
git commit -m "feat: add teacher dashboard analytics and exports"
```
