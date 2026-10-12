# 十秒單場對戰及 Chrome 100 場驗收

使用者已指定十秒、單場、目前 Chrome 的設計及 100 場人機對戰，沿用既有自動除錯／部署授權，採主代理內聯執行。

**目標：** 發射判定完成後播放 10 秒對戰，首輪結果即結算；平手亦停止，返回房間後才可另開新場。

**架構：** 後端保持唯一物理結果及發射判定，presentation 改 10,000ms／8,000ms 召喚；前端沿用按 durationMs 正規化的特效。單場勝方得 1 對戰分，平手雙方 0 分；原挑戰分計算保留。既有兩勝歷史資料保持可讀，新增資料庫約束遷移允許單場及平手，不刪除紀錄。

**工作目錄：** `/Users/cywong/Documents/Codex/Bayblad-Simulator-20260911`。保留 `.superpowers/`，不使用舊掛載工作樹或已停止代理。

**追加要求：** 玩家入房／坐上對戰席自動準備一次；離線／命令未完成時先等候，準備失敗保留手動重試，不連續自動再戰。觀眾不準備。主頁左上角與頁尾 ARENA LAB 改為 YUENHK，字體、大小及顏色不變。

- [ ] `apps/server/src/battle/presentation.test.ts`：十秒端點、五秒中段、八秒召喚；`scoring.test.ts`：單勝及平手；protocol／db／repository 保留舊結果，驗證新單場結果。
- [ ] 調整 `presentation.ts`、`socket.ts`、`scoring.ts`、`packages/protocol/src/events.ts`；第一輪勝敗／平手均生成 match.finished，沒有第二輪 launch.schedule。
- [ ] `packages/db/src/persistence.ts`、`schema.ts`、新 `drizzle/0007_single_round_matches.sql`、journal 及 pinned migration manifest：容許單場，平手 winner=null／roundWinners=[]，維持總分與勝方約束和歷史兩胜結果。
- [ ] `BattleArena.tsx` 容許 10000ms；`RoomPage.tsx`／`MatchResult.tsx` 顯示 1:0／0:1／平手，保留舊 2:0／2:1 歷史型別。
- [ ] 更新受賽制影響的舊測試，保留身份、隱私、觀賽、斷線、持久化與安全斷言。執行 `pnpm test`、`pnpm typecheck`、`pnpm build`、`pnpm test:e2e`，CI 真 PostgreSQL 及安全閘門通過才部署。
- [ ] GitHub Pages／Render 指定同一功能版本，核實公開 ready、資產與單場正常结算。若登入失效，保留完成工作並報告精確登入阻擋。
- [ ] 以 Computer Use 操作使用者既有 Chrome 分頁，保留目前 49.7g 自定設計，實際建立／準備／發射／讀取結果／返回房間，共 100 場電腦玩家對戰。以 UI 結果逐場記錄勝／敗／平手、分數、錯誤；每場必須完整可見，不以 API 模擬替代。保存最後畫面及結果檔。
