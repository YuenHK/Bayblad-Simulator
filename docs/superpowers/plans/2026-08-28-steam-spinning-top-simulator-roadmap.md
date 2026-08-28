# STEAM 陀螺模擬器實作路線圖

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推薦）或 superpowers:executing-plans 逐任務實現下列計劃。步驟使用復選框（`- [ ]`）語法來跟蹤進度。

**目標：** 依四個可獨立驗證的階段，由空白資料夾建立可公開部署的 STEAM 陀螺設計、即時對戰及教師分析平台。

**架構：** 使用 pnpm TypeScript monorepo，React/Vite 負責學生及教師網頁，Fastify/Socket.IO 負責 API 與即時狀態，Planck 負責伺服器 2D 物理，PostgreSQL/Drizzle 保存紀錄。所有共享規則置於獨立 domain/protocol 套件，避免前後端計算分歧。

**技術棧：** Node.js 24、pnpm 11、TypeScript 7、React 19、Vite 8、Fastify 5、Socket.IO 4、Planck 1、Three.js、React Three Fiber、Zod 4、PostgreSQL、Drizzle、Vitest 4、Playwright 1、ExcelJS 4、Recharts 3、Docker、Caddy。

---

## 執行次序

1. [2026-08-28-foundation-design-engine-plan.md](./2026-08-28-foundation-design-engine-plan.md)
   - 產出可在 iPad／桌面使用的參數化設計器、規格驗證、性能預測及 3D 預覽。
2. [2026-08-28-realtime-battle-plan.md](./2026-08-28-realtime-battle-plan.md)
   - 產出大廳、房間、觀賽、節拍發射、伺服器 2D 物理、計分及重連。
3. [2026-08-28-identity-admin-analytics-plan.md](./2026-08-28-identity-admin-analytics-plan.md)
   - 產出 iClass 整合接口、訪客／Cookie 身份、教師後台、統計、Excel、刪除及備份。
4. [2026-08-28-deployment-acceptance-plan.md](./2026-08-28-deployment-acceptance-plan.md)
   - 產出 HTTPS 公開部署、效能／安全測試、iPad 實機驗收及上線清單。

## 階段關卡

- [ ] 第一階段：設計器單元測試、元件測試及 Playwright 測試全部通過。
- [ ] 第二階段：兩名玩家及至少 20 名模擬觀賽者取得一致戰況，重連及計分測試通過。
- [ ] 第三階段：三種身份狀態、管理員權限、統計、Excel、刪除及還原測試通過。
- [ ] 第四階段：HTTPS、安全掃描、負載測試及學校管理 iPad 實機驗收通過。

## 共通提交規則

- 每個任務先寫失敗測試，再寫最少實作。
- 每個任務完成後執行該任務指定測試，再 commit。
- 不把 `admin` 密碼、資料庫密碼、簽署密鑰或 iClass 憑證提交到 Git。
- 每個階段結束執行 `pnpm lint && pnpm typecheck && pnpm test && pnpm test:e2e`。

