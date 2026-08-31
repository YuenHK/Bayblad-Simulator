# 對戰判定、老師確認流程及自適應 UI 實現計劃

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推薦）或 superpowers:executing-plans 逐任務實現此計劃。步驟使用復選框（`- [ ]`）語法來跟蹤進度。

**目標：** 消除過期發射的 `ROUND_CLOSED` 紅色錯誤，將老師高風險操作改成登入後雙重確認，並讓學生與老師介面自適應電腦、iPad 和手機。

**架構：** 即時協議傳送權威發射截止時間，伺服器保持最終判定不可改寫，客戶端在期限後鎖定輸入。老師操作沿用工作階段、CSRF、一次性預覽及稽核，但移除密碼再驗證。響應式外殼只重排現有元件，手機設計室增加可存取的三頁籤，手機發射階段加入專注模式。

**技術棧：** TypeScript、React 19、Socket.IO、Fastify、Zod、Vitest、Testing Library、Playwright、CSS media queries。

---

## 文件結構

- `packages/protocol/src/events.ts`：在 `launch.schedule` 加入截止時間。
- `apps/server/src/battle/launch.ts`、`apps/server/src/socket.ts`：產生截止時間並安全處理延遲發射。
- `apps/web/src/realtime/socket-client.ts`、`RhythmLaunch.tsx`：轉換截止時間並在期限後鎖定輸入。
- `apps/server/src/admin/dashboard-routes.ts`、`delete-records.ts`：以登入工作階段及明確確認取代密碼再驗證。
- `apps/web/src/features/admin/AdminDashboard.tsx`、`DeleteDialog.tsx`：房間操作及刪除使用兩階段確認。
- `DesignerPage.tsx`、`RoomPage.tsx`、`App.tsx`、`styles.css`：手機三頁籤、發射專注模式及裝置斷點。
- 對應 `*.test.ts(x)` 及 `tests/e2e/responsive.spec.ts`：回歸及響應式驗收。

### 任務 1：權威發射截止時間

**文件：**
- 修改：`packages/protocol/src/events.ts`
- 測試：`packages/protocol/src/events.test.ts`
- 修改：`apps/server/src/battle/launch.ts`
- 測試：`apps/server/src/battle/launch.test.ts`
- 修改：`apps/server/src/socket.ts`
- 測試：`apps/server/src/app.test.ts`

- [ ] **步驟 1：編寫失敗測試**

```ts
expect(schedule.serverDeadlineTimeMs).toBe(schedule.serverTargetTimeMs + 1_500);
coordinator.finalizeExpired(schedule.serverDeadlineTimeMs + 1);
const late = coordinator.submit("p1", tap({ eventId: LATE_ID }), schedule.serverDeadlineTimeMs + 2);
expect(late.event.grade).toBe("Miss");
expect(late.replayed).toBe(true);
```

- [ ] **步驟 2：確認紅燈**

運行：`pnpm --filter @steam-top/protocol test -- --run src/events.test.ts && pnpm --filter @steam-top/server test -- --run src/battle/launch.test.ts src/app.test.ts`。預期因缺少 deadline 或仍拋 `ROUND_CLOSED` 而 FAIL。

- [ ] **步驟 3：最少實作**

`launch.schedule` 加入安全整數 `serverDeadlineTimeMs`。伺服器在 `state.closed` 且該參與者已有權威結果時回傳該結果及 `replayed: true`；身份、nonce、回合及參與者檢查仍先執行，且不得重新模擬。

- [ ] **步驟 4：確認綠燈並提交**

```bash
pnpm --filter @steam-top/protocol test
pnpm --filter @steam-top/server test
git add packages/protocol/src apps/server/src/battle/launch.ts apps/server/src/battle/launch.test.ts apps/server/src/socket.ts apps/server/src/app.test.ts
git commit -m "fix: make expired launch taps idempotent"
```

### 任務 2：學生端截止狀態

**文件：**
- 修改：`apps/web/src/realtime/socket-client.ts`
- 測試：`apps/web/src/realtime/socket-client.test.ts`
- 修改：`apps/web/src/App.tsx`
- 修改：`apps/web/src/features/battle/RhythmLaunch.tsx`
- 測試：`apps/web/src/features/battle/RhythmLaunch.test.tsx`

- [ ] **步驟 1：編寫失敗測試**

```tsx
vi.setSystemTime(deadline + 1);
expect(screen.getByRole("button", { name: "本輪已結束，等待下一輪" })).toBeDisabled();
fireEvent.keyDown(window, { code: "Space" });
expect(onCommand).not.toHaveBeenCalled();
```

- [ ] **步驟 2：確認紅燈**

運行：`pnpm --filter @steam-top/web test -- RhythmLaunch.test.tsx socket-client.test.ts`。預期元件仍會送命令而 FAIL。

- [ ] **步驟 3：最少實作**

目標及 deadline 一併轉換到客戶端時間。`RhythmLaunch` 以 deadline 決定 `expired`，停止計時、停用 pointer／click／Space 並顯示等待狀態；不改現有字體或配色。

- [ ] **步驟 4：確認綠燈並提交**

```bash
pnpm --filter @steam-top/web test -- RhythmLaunch.test.tsx socket-client.test.ts
git add apps/web/src/realtime/socket-client.ts apps/web/src/realtime/socket-client.test.ts apps/web/src/App.tsx apps/web/src/features/battle
git commit -m "fix: close launch controls at server deadline"
```

### 任務 3：老師登入後雙重確認

**文件：**
- 修改：`apps/server/src/admin/dashboard-routes.ts`
- 測試：`apps/server/src/admin/dashboard-routes.test.ts`
- 修改：`apps/server/src/admin/delete-records.ts`
- 測試：`apps/server/src/admin/delete-records.test.ts`
- 測試：`apps/server/src/admin/delete-records.postgres.test.ts`
- 修改：`apps/web/src/features/admin/AdminDashboard.tsx`
- 修改：`apps/web/src/features/admin/DeleteDialog.tsx`
- 測試：`apps/web/src/features/admin/AdminDashboard.test.tsx`

- [ ] **步驟 1：編寫失敗 API 與 UI 測試**

```ts
expect(body).not.toHaveProperty("password");
expect(body).toMatchObject({ confirmed: true });
expect(screen.queryByLabelText("再次輸入管理員密碼")).not.toBeInTheDocument();
```

測試必須證明第一下只進入第二階段，第二下才送出請求；缺少嚴格 `confirmed: true`、工作階段或 CSRF 均被拒絕。

- [ ] **步驟 2：確認紅燈**

運行：`pnpm --filter @steam-top/server test -- --run src/admin/dashboard-routes.test.ts src/admin/delete-records.test.ts && pnpm --filter @steam-top/web test -- AdminDashboard.test.tsx`。

- [ ] **步驟 3：最少實作**

嚴格請求 schema 以 `confirmed: z.literal(true)` 取代 `password`／`confirmation`。保留 mutation authentication、CSRF、工作階段、operation id、preview token、filter hash、期限、一次性消耗及稽核；離線 reconciliation CLI 的獨立授權不改。

- [ ] **步驟 4：實作兩階段 UI**

房間命令與永久刪除使用 `review`／`confirm` 狀態。第一頁顯示摘要及「繼續」，第二頁顯示不可還原警告及最終按鈕；關閉 modal 清除狀態，兩個按鈕使用不同排列位置。

- [ ] **步驟 5：確認綠燈並提交**

```bash
pnpm --filter @steam-top/server test -- --run src/admin/dashboard-routes.test.ts src/admin/delete-records.test.ts
pnpm --filter @steam-top/web test -- AdminDashboard.test.tsx
git add apps/server/src/admin apps/web/src/features/admin
git commit -m "feat: use session-bound admin confirmations"
```

### 任務 4：自適應設計室與對戰專注模式

**文件：**
- 修改：`apps/web/src/features/designer/DesignerPage.tsx`
- 測試：`apps/web/src/features/designer/DesignerPage.test.tsx`
- 修改：`apps/web/src/features/room/RoomPage.tsx`
- 測試：`apps/web/src/features/room/RoomPage.test.tsx`
- 修改：`apps/web/src/App.tsx`
- 修改：`apps/web/src/styles.css`

- [ ] **步驟 1：編寫失敗測試**

```tsx
expect(screen.getByRole("tablist", { name: "設計室區域" })).toBeVisible();
await userEvent.keyboard("{ArrowRight}");
expect(screen.getByRole("tab", { name: "模擬預覽" })).toHaveAttribute("aria-selected", "true");
expect(container.querySelector(".battle-focus-mode")).toBeTruthy();
```

- [ ] **步驟 2：確認紅燈**

運行：`pnpm --filter @steam-top/web test -- DesignerPage.test.tsx RoomPage.test.tsx`。

- [ ] **步驟 3：最少實作**

桌面保留現有面板同時可見；最多 599px 時只顯示 active panel。頁籤提供 `tablist/tab/tabpanel`、左右鍵切換，切換可見性但不重設設計。玩家 launch phase 為 app 外殼加入專注模式 class；觀眾及其他 phase 不加入。

- [ ] **步驟 4：完成 CSS 斷點**

1024px 以上多欄；600–1023px 按空間重排；599px 以下單欄／頁籤。加入 `env(safe-area-inset-*)`、局部表格橫向捲動、`min-width: 0`、44px 觸控目標及 reduced-motion；不改字體、字級、字型或配色。

- [ ] **步驟 5：確認綠燈並提交**

```bash
pnpm --filter @steam-top/web test -- DesignerPage.test.tsx RoomPage.test.tsx
git add apps/web/src/features/designer apps/web/src/features/room apps/web/src/App.tsx apps/web/src/styles.css
git commit -m "feat: adapt simulator UI across device sizes"
```

### 任務 5：整體驗證、視覺 QA 與部署

**文件：**
- 建立：`tests/e2e/responsive.spec.ts`

- [ ] **步驟 1：加入 e2e 驗收**

測試 390×844、768×1024、1024×768、1440×900，確認沒有頁面級非預期水平溢出且主要操作可達；手機另驗證三頁籤及發射專注模式。

- [ ] **步驟 2：完整驗證**

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm test:e2e
```

預期全部退出碼 0。若環境缺少 PostgreSQL 或瀏覽器依賴，必須明確區分環境限制與程式失敗並完成其餘驗證。

- [ ] **步驟 3：瀏覽器視覺 QA**

在四種 viewport 檢查學生設計室、大廳、房間、發射畫面及老師後台；確認現有字體／字級／配色未改、沒有遮擋，直橫向切換及 reduced motion 正常。

- [ ] **步驟 4：提交、推送及公開驗證**

```bash
git add tests/e2e/responsive.spec.ts
git commit -m "test: cover responsive simulator flows"
git push origin HEAD:main
```

等待 GitHub Pages 及 Render 使用新 commit。以兩個獨立訪客完成建立房間、準備、準時／過期發射及一輪結果，確認不顯示 `ROUND_CLOSED`。老師端只測試不涉及真實資料的預覽／取消，不執行真實永久刪除。
