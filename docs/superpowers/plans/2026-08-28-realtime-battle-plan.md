# 即時房間與物理對戰實作計劃

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推薦）或 superpowers:executing-plans 逐任務實現此計劃。步驟使用復選框（`- [ ]`）語法來跟蹤進度。

**目標：** 在設計器上加入公開大廳、兩個對戰席、無固定上限觀賽區、每輪節拍發射、伺服器 2D 物理、賽後計分及兩分鐘重連。

**架構：** `packages/protocol` 以 Zod 定義 Socket.IO 事件；`apps/server` 保存權威房間狀態和 Planck 世界；`apps/web` 只呈現伺服器快照。每場只模擬一次再廣播，觀賽人數不增加物理計算次數。

**技術棧：** Fastify 5、Socket.IO 4、Planck 1、Zod 4、React 19、Vitest 4、Playwright 1。

---

## 檔案結構

- `packages/protocol/src/events.ts`：事件 schema 及共享型別
- `apps/server/src/rooms/room-service.ts`：房間、席位、房主及重連
- `apps/server/src/battle/launch.ts`：節拍判定
- `apps/server/src/battle/engine.ts`：Planck 物理世界
- `apps/server/src/battle/scoring.ts`：三局兩勝及挑戰分
- `apps/server/src/socket.ts`：事件驗證與廣播
- `apps/web/src/features/lobby/`：大廳
- `apps/web/src/features/room/`：房間及觀賽
- `apps/web/src/features/battle/`：節拍、戰況及賽後結果

### 任務 1：建立共享即時通訊協定

**文件：**
- 建立：`packages/protocol/package.json`
- 建立：`packages/protocol/src/events.ts`
- 測試：`packages/protocol/src/events.test.ts`

- [ ] **步驟 1：建立 protocol package manifest**

```json
{
  "name": "@steam-top/protocol", "private": true, "type": "module",
  "exports": { ".": "./src/events.ts" },
  "scripts": { "test": "vitest run", "typecheck": "tsc --noEmit", "build": "tsc --noEmit", "lint": "tsc --noEmit" },
  "dependencies": { "zod": "4.4.3" },
  "devDependencies": { "typescript": "7.0.2", "vitest": "4.1.11" }
}
```

- [ ] **步驟 2：編寫非法事件測試**

```ts
it("rejects ready without a design id", () => {
  expect(() => clientEventSchema.parse({ type: "player.ready", roomId: "A102" })).toThrow();
});

it("accepts a spectator join", () => {
  expect(clientEventSchema.parse({ type: "room.join", roomId: "A102", role: "spectator" }).role).toBe("spectator");
});
```

- [ ] **步驟 3：執行確認失敗**

執行：`pnpm --filter @steam-top/protocol test`

預期：FAIL，schema 未定義。

- [ ] **步驟 4：定義 Zod discriminated union**

```ts
export const clientEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("room.create"), name: z.string().min(1).max(30) }),
  z.object({ type: z.literal("room.join"), roomId: z.string(), role: z.enum(["player", "spectator"]) }),
  z.object({ type: z.literal("room.move"), target: z.enum(["player1", "player2", "spectator"]) }),
  z.object({ type: z.literal("player.ready"), roomId: z.string(), designId: z.string().uuid() }),
  z.object({ type: z.literal("launch.tap"), roomId: z.string(), roundId: z.string(), clientTimeMs: z.number() }),
  z.object({ type: z.literal("room.close"), roomId: z.string() })
]);
```

伺服器事件明確定義 `lobby.snapshot`、`room.snapshot`、`launch.schedule`、`launch.result.private`、`launch.result.spectator`、`battle.frame`、`round.finished`、`match.finished` 及 `error`。

- [ ] **步驟 5：執行測試並 Commit**

執行：`pnpm --filter @steam-top/protocol test`

預期：全部 PASS。

```bash
git add packages/protocol pnpm-lock.yaml
git commit -m "feat: define realtime battle protocol"
```

### 任務 2：房間、席位、房主及空房生命週期

**文件：**
- 建立：`apps/server/package.json`
- 建立：`apps/server/src/rooms/room-service.ts`
- 測試：`apps/server/src/rooms/room-service.test.ts`

- [ ] **步驟 1：建立 server package manifest**

```json
{
  "name": "@steam-top/server", "private": true, "type": "module",
  "scripts": { "dev": "tsx watch src/index.ts", "build": "tsc -p tsconfig.json", "test": "vitest run", "typecheck": "tsc --noEmit", "lint": "tsc --noEmit" },
  "dependencies": {
    "@steam-top/domain": "workspace:*", "@steam-top/protocol": "workspace:*", "fastify": "5.12.1", "planck": "1.5.0", "socket.io": "4.8.3", "zod": "4.4.3"
  },
  "devDependencies": { "tsx": "4.23.12", "typescript": "7.0.2", "vitest": "4.1.11" }
}
```

執行：`pnpm install`

- [ ] **步驟 2：用 fake timers 編寫生命週期測試**

```ts
it("transfers ownership after a two-minute owner disconnect", () => {
  const room = rooms.create(userA, "測試房");
  rooms.join(room.id, userB, "spectator");
  rooms.disconnect(userA.id);
  clock.advanceBy(120_001);
  rooms.sweep();
  expect(rooms.get(room.id)?.ownerId).toBe(userB.id);
});

it("deletes a room after two empty minutes", () => {
  rooms.leave(room.id, userA.id);
  clock.advanceBy(120_001);
  rooms.sweep();
  expect(rooms.get(room.id)).toBeUndefined();
});
```

- [ ] **步驟 3：執行確認失敗**

執行：`pnpm --filter @steam-top/server test -- room-service.test.ts`

預期：FAIL，room service 未建立。

- [ ] **步驟 4：實作權威狀態機**

```ts
export type RoomPhase = "waiting" | "launch" | "battle" | "result";
export type Seat = Readonly<{ userId: string; ready: boolean; designId: string | null }>;
export type Room = Readonly<{
  id: string; code: string; name: string; ownerId: string; phase: RoomPhase;
  player1: Seat | null; player2: Seat | null; spectators: readonly string[];
  emptySinceMs: number | null;
}>;
```

所有 mutation 經 service 方法完成。對戰期間拒絕房主移動玩家或關閉單一對戰，教師管理事件例外。

- [ ] **步驟 5：加入 500 名觀賽者快照測試**

建立 500 個 spectator fixture，確認全部名字只出現在一份房間快照，房間不設產品人數上限。

- [ ] **步驟 6：跑測試並 Commit**

執行：`pnpm --filter @steam-top/server test -- room-service.test.ts`

預期：全部 PASS。

```bash
git add apps/server packages/protocol
git commit -m "feat: manage rooms seats spectators and ownership"
```

### 任務 3：節拍發射排程及四級判定

**文件：**
- 建立：`apps/server/src/battle/launch.ts`
- 測試：`apps/server/src/battle/launch.test.ts`

- [ ] **步驟 1：編寫判定窗口測試**

```ts
it.each([
  [0, "Perfect", 1.10], [45, "Perfect", 1.10],
  [46, "Great", 1.00], [100, "Great", 1.00],
  [101, "Good", 0.90], [180, "Good", 0.90],
  [181, "Miss", 0.75]
])("maps %sms to %s", (deltaMs, grade, multiplier) => {
  expect(judgeLaunch(deltaMs)).toMatchObject({ grade, angularMultiplier: multiplier, impulseMultiplier: multiplier });
});
```

- [ ] **步驟 2：執行確認失敗**

執行：`pnpm --filter @steam-top/server test -- launch.test.ts`

預期：FAIL，`judgeLaunch` 未定義。

- [ ] **步驟 3：實作排程與一次性 nonce**

```ts
export const LAUNCH_WINDOWS_MS = { perfect: 45, great: 100, good: 180 } as const;
export const LAUNCH_MULTIPLIER = { Perfect: 1.10, Great: 1.00, Good: 0.90, Miss: 0.75 } as const;
```

排程包含 `roundId`、`serverTargetTimeMs` 及 nonce。以估算時鐘偏差修正 `clientTimeMs`；超出排程範圍、重複 nonce 或第二次提交一律拒絕。

- [ ] **步驟 4：測試角色資料裁剪**

玩家 payload 只包含自己的 grade；spectator payload 含雙方 grade。使用 schema 快照防止日後洩露。

- [ ] **步驟 5：跑測試並 Commit**

執行：`pnpm --filter @steam-top/server test -- launch.test.ts`

預期：全部 PASS。

```bash
git add apps/server/src/battle packages/protocol
git commit -m "feat: add synchronized rhythm launch judgement"
```

### 任務 4：伺服器 Planck 物理引擎

**文件：**
- 建立：`apps/server/src/battle/engine.ts`
- 建立：`apps/server/src/battle/prng.ts`
- 建立：`apps/server/src/battle/collision-proxy.ts`
- 建立：`apps/server/src/battle/planck-config.ts`
- 測試：`apps/server/src/battle/engine.test.ts`

- [ ] **步驟 1：編寫可重播測試**

```ts
it("replays identical frames from one seed", () => {
  const first = simulateMatchRound(fixtureA, fixtureB, { seed: 12345, launchA, launchB });
  const second = simulateMatchRound(fixtureA, fixtureB, { seed: 12345, launchA, launchB });
  expect(second).toEqual(first);
});
```

- [ ] **步驟 2：執行確認失敗**

執行：`pnpm --filter @steam-top/server test -- engine.test.ts`

預期：FAIL，引擎未建立。

- [ ] **步驟 3：實作固定步長世界**

```ts
export const PHYSICS_MODEL_VERSION = "2.0.0";
export const STEP_SECONDS = 1 / 60;
export const MAX_ROUND_SECONDS = 90;

export type BattleFrame = Readonly<{
  tick: number;
  player1: { x: number; y: number; angle: number; angularSpeed: number };
  player2: { x: number; y: number; angle: number; angularSpeed: number };
}>;
```

Planck 建立 server-authoritative SI 世界、dynamic bodies、arena wall 及 top-to-top sensor broadphase；質量、重心、極慣量及性能只由通過 domain 驗證的 canonical design 重算。top-to-top narrow phase 使用誤差不超過 0.35 mm 的 canonical concave radial outline，並以 edge AABB spatial grid 限制候選線段。接觸以 pair-level episode 去重，每個 episode 只施加一次由 impact resistance 映射的自訂 impulse 及 angular retention。

**實作決策記錄（2026-08-28）：** 不再使用 compound solid fixtures 處理 top-to-top 碰撞，因內部三角接縫會令 Planck 在一次碰撞產生多重 solver impulses，造成座位不公平及回合過早終止。實體 convex proxy 只與 arena wall 碰撞；concave silhouette 的 sensor/narrow-phase 不產生 Planck solver impulse。arena wall 位於安全中心界線加最大合法半徑及 margin 之外，確保中心越過 70 mm 的權威出界判定先發生。

seed PRNG 只產生有界起始方向及擾動。物理固定 60 Hz，15 Hz 收集 frames；`simulateOnce` 是只接受本機 test store 的 deprecated 同步測試入口，production handler 只使用 cooperative `simulateOnceAsync`，不得同步阻塞資料庫。`BattleEngine` constructor 必須顯式注入 repository，並以 `maxConcurrent`、`maxQueued`、FIFO queue 及每 chunk 運算時間預算限制 event-loop 阻塞；TTL/LRU result cache 只作加速。完成結果以固定長度 SHA-256 canonical fingerprint 寫入具 async atomic `saveIfAbsent` 契約的 authoritative `ResultRepository`；跨 engine race 必須採用 repository 回傳的 winner record。Phase 3 的 PostgreSQL implementation 可再以 advisory lock／claim lease 避免跨 process 重複運算。

`InMemoryCompletedRoundStore` 只供測試／單程序開發，full results 與 total records 均有獨立上限；result 淘汰先降為 tombstone，record LRU 淘汰後則不再具權威性，因此絕不能作 production fallback。production composition 必須顯式注入 Phase 3 持久 repository，確保同一 match/round 即使 cache 到期或淘汰仍不會重新模擬。

- [ ] **步驟 4：實作勝負條件**

停止閾值持續 500 ms 判停止；中心越過安全圈判出界；同一 tick 同時停止／出界回傳 `draw` 並重賽。

- [ ] **步驟 5：執行校準測試並 Commit**

執行：`pnpm --filter @steam-top/server test -- engine.test.ts`

預期：相同 seed 完全相同；有明顯優勢的 fixture 在五個校準 seed 下不被小量隨機值反轉；合法最大陀螺有可達的 70 mm 中心出界路徑；cache TTL/LRU 淘汰後仍由 authoritative repository 回傳同一結果而不增加 simulation count；最大 16 角星雙局並行時符合 heartbeat 上限。

```bash
git add apps/server/src/battle packages/domain
git commit -m "feat: simulate deterministic server-side top battles"
```

### 任務 5：三局兩勝及挑戰分

**文件：**
- 建立：`apps/server/src/battle/scoring.ts`
- 測試：`apps/server/src/battle/scoring.test.ts`

- [ ] **步驟 1：編寫官方例子測試**

```ts
it("scores 50g versus 40g at 2:1", () => {
  const result = scoreMatch({
    player1MassG: 50,
    player2MassG: 40,
    roundWinners: ["player1", "player2", "player1"]
  });
  expect(result.winner).toBe("player1");
  expect(result.player1).toEqual({ battlePoints: 2, challengePoints: 0, total: 2 });
  expect(result.player2).toEqual({ battlePoints: 1, challengePoints: 0.5, total: 1.5 });
});
```

- [ ] **步驟 2：執行確認失敗**

執行：`pnpm --filter @steam-top/server test -- scoring.test.ts`

預期：FAIL，計分未定義。

- [ ] **步驟 3：實作純函式計分**

`scoreMatch` 以 strict Zod schema 一次解析輸入，只接受 2:0 或 2:1；平局重賽不加入
`roundWinners`。欄位和勝方一律沿用 protocol 的 `player1`／`player2` 命名，結果為不可變物件。

Domain 會產生高精度模擬重量，但沒有另訂磅秤精度。因此計分邊界明確採用 1 mg（0.001 g）
量化：先由已解析的兩個原始重量計算一次絕對差值，再只把差值轉為整數毫克並計算
`min(重量差（g）× 0.05, 0.5)`。這可保留 9.999 g／10 g 的上限邊界，並避免二進制
浮點乘法造成分數尾數；相同原始差值亦不會因兩個絕對重量的小數位置而得到不同分數。
量化前只加入以 Domain `MAX_MASS_G` 推導的 binary64 運算容差
`Number.EPSILON × MAX_MASS_G × 2`：它涵蓋兩個最多 60 g 運算元及相減的 ULP 誤差，
同時遠小於 0.001 g，不會實質移動半毫克門檻。

- [ ] **步驟 4：執行測試並 Commit**

執行：`pnpm --filter @steam-top/server test -- scoring.test.ts`

預期：2:0、2:1、輕重相同及 0.5 上限全部 PASS。

```bash
git add apps/server/src/battle/scoring*
git commit -m "feat: score best-of-three battles and weight challenge"
```

### 任務 6：Fastify／Socket.IO 整合

**文件：**
- 建立：`apps/server/src/app.ts`
- 建立：`apps/server/src/socket.ts`
- 測試：`apps/server/src/socket.test.ts`

- [ ] **步驟 1：編寫雙玩家加觀賽者整合測試**

啟動記憶體伺服器，建立房間、入席、準備，斷言玩家只收到私人 launch payload，觀賽者收到雙方判定。

- [ ] **步驟 2：執行確認失敗**

執行：`pnpm --filter @steam-top/server test -- socket.test.ts`

預期：FAIL，伺服器入口未建立。

- [ ] **步驟 3：實作 schema 驗證、權限和冪等鍵**

每個事件先經 `clientEventSchema.safeParse`。房主、玩家及教師命令分別授權；`player.ready`、`launch.tap`、`match.finished` 以 event id／round id 防止重複。

- [ ] **步驟 4：加入 session 重連**

socket 重連以 session id 取回席位；兩分鐘後才轉移房主或清空席位。

- [ ] **步驟 5：跑整合測試並 Commit**

執行：`pnpm --filter @steam-top/server test`

預期：全部 PASS。

```bash
git add apps/server/src
git commit -m "feat: expose authoritative realtime battle server"
```

### 任務 7：大廳、房間、節拍及戰況 UI

**文件：**
- 建立：`apps/web/src/features/lobby/LobbyPage.tsx`
- 建立：`apps/web/src/features/room/RoomPage.tsx`
- 建立：`apps/web/src/features/room/SpectatorList.tsx`
- 建立：`apps/web/src/features/battle/RhythmLaunch.tsx`
- 建立：`apps/web/src/features/battle/BattleArena.tsx`
- 建立：`apps/web/src/features/battle/MatchResult.tsx`
- 建立：`apps/web/src/realtime/socket-client.ts`
- 測試：`apps/web/src/features/room/RoomPage.test.tsx`

先執行：`pnpm --filter @steam-top/web add socket.io-client@4.8.3`

- [ ] **步驟 1：編寫角色可見性測試**

```tsx
it("hides opponent grade from a player", () => {
  render(<RoomPage snapshot={playerSnapshot} />);
  expect(screen.getByText("PERFECT")).toBeVisible();
  expect(screen.queryByText("對手判定：GREAT")).not.toBeInTheDocument();
});

it("shows both grades to a spectator", () => {
  render(<RoomPage snapshot={spectatorSnapshot} />);
  expect(screen.getByText("玩家一：PERFECT")).toBeVisible();
  expect(screen.getByText("玩家二：GREAT")).toBeVisible();
});
```

- [ ] **步驟 2：實作快照驅動 UI**

按鈕只送事件，畫面狀態由伺服器 snapshot 更新；不在本地推測席位或勝負。

- [ ] **步驟 3：實作節拍及 Canvas 戰況**

節拍以 server target time 對齊；`BattleArena` 只內插 15 Hz frames。支援 `prefers-reduced-motion`。

- [ ] **步驟 4：測試分數只在賽後顯示**

waiting、launch、battle phase 不渲染分數或排行榜；只有 `result` phase 顯示對戰分、挑戰分及總分。

- [ ] **步驟 5：執行測試並 Commit**

執行：`pnpm --filter @steam-top/web test`

預期：角色可見性、按鈕狀態及賽後分數測試 PASS。

```bash
git add apps/web/src/features apps/web/src/realtime
git commit -m "feat: add lobby rooms spectators and battle ui"
```

### 任務 8：多角色 E2E 及觀賽負載基線

**文件：**
- 建立：`tests/e2e/battle.spec.ts`
- 建立：`tests/load/spectators.mjs`

- [ ] **步驟 1：建立三瀏覽器 E2E**

Playwright 使用兩個 player context 及一個 spectator context，完成建房、入席、準備、每輪節拍、三輪內完場及賽後計分。

- [ ] **步驟 2：加入房主移動及兩分鐘 fake-clock 測試**

覆蓋房主轉觀賽、斷線重連、逾時轉移和空房刪除；以伺服器注入時鐘避免真等兩分鐘。

- [ ] **步驟 3：建立 20 名觀賽者負載測試**

連接同一房間，斷言所有 client 最終 frame tick 和 match id 一致，伺服器物理模擬計數為 1。

- [ ] **步驟 4：執行階段品質閘門**

執行：`pnpm lint && pnpm typecheck && pnpm test && pnpm test:e2e && node tests/load/spectators.mjs`

預期：全部 PASS。

- [ ] **步驟 5：Commit**

```bash
git add tests apps
git commit -m "test: verify realtime battle and spectator consistency"
```
