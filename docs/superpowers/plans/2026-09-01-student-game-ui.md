# 學生端線上遊戲化介面實現計劃

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推薦）或 superpowers:executing-plans 逐任務實現此計劃。步驟使用復選框（`- [ ]`）語法來跟蹤進度。

**目標：** 在保持現有業務規則及老師端不變的情況下，為學生設計、房間、節拍發射及陀螺對戰加入新潮競技遊戲視覺、互動、聲音與可調節特效。

**架構：** 新增獨立的遊戲偏好、Web Audio、判定呈現及競技場視覺事件模組；React 頁面只消費這些明確介面。全站主題集中於學生根節點下，避免污染老師端 CSS。對戰特效從既有伺服器事件及戰況幀衍生，不更改協議或計分。

**技術棧：** React 19、TypeScript、SVG、CSS、Web Audio API、Vitest、Testing Library、Playwright。

---

## 文件結構

- 建立 `apps/web/src/features/game/gamePreferences.ts`：音效、動態與品質偏好的安全儲存及解析。
- 建立 `apps/web/src/features/game/GameAudio.ts`：延遲建立的 Web Audio 合成器與事件 API。
- 建立 `apps/web/src/features/game/GameHudControls.tsx`：可存取的音效及動態控制。
- 建立 `apps/web/src/features/battle/battleEffects.ts`：判定文案映射、碰撞／場邊事件與穩定識別。
- 修改 `apps/web/src/App.tsx`：學生端偏好狀態、HUD 控制及音效生命週期。
- 修改 `apps/web/src/features/designer/DesignerPage.tsx`、`LobbyPage.tsx`、`RoomPage.tsx`：加入遊戲化語義 class 及狀態結構。
- 修改 `apps/web/src/features/battle/RhythmLaunch.tsx`、`BattleArena.tsx`、`MatchResult.tsx`：節拍、判定、粒子、碰撞及勝負效果。
- 修改 `apps/web/src/styles.css`：限定在學生端根節點的視覺系統、響應式及低動態樣式。
- 修改相應 `*.test.ts(x)` 及 `tests/public-e2e/public-acceptance.spec.ts`：行為與公開站驗收。

### 任務 1：遊戲偏好與音效基礎

- [ ] 在 `gamePreferences.test.ts` 寫入失敗測試：損壞儲存值回復安全預設、靜音及低動態可往返保存。
- [ ] 執行 `pnpm --filter @steam-top/web exec vitest run src/features/game/gamePreferences.test.ts`，確認因模組不存在而失敗。
- [ ] 實作 `gamePreferences.ts` 的純函式及安全儲存邊界，重跑測試至通過。
- [ ] 在 `GameAudio.test.ts` 寫入失敗測試：未解鎖不建立聲音、靜音不播放、同一事件鍵只播放一次、dispose 停止聲音。
- [ ] 實作 `GameAudio.ts`，以可注入 AudioContext factory 測試；重跑兩個測試檔。
- [ ] 提交 `feat: add student game preferences and audio engine`。

### 任務 2：HUD 與學生視覺系統

- [ ] 在 `App.test.tsx` 寫入失敗測試：學生端顯示音效／動態控制、切換後更新狀態及儲存，老師入口不出現控制。
- [ ] 執行指定測試並確認缺少控制而失敗。
- [ ] 實作 `GameHudControls.tsx` 並在 `App.tsx` 接入偏好及音效解鎖。
- [ ] 為 `DesignerPage.test.tsx` 先加入 HUD class、能力儀表語義及原有標籤保留測試，確認失敗後實作最少結構。
- [ ] 在 `styles.css` 以 `.student-game` 為根加入色彩 token、背景、HUD、面板、按鍵、設計模組和全息預覽；不改 admin 根樣式。
- [ ] 執行 `App.test.tsx`、`DesignerPage.test.tsx` 及 axe/ARIA 現有測試至通過。
- [ ] 提交 `feat: transform student designer into competitive game HUD`。

### 任務 3：大廳與房間競技介面

- [ ] 在 `LobbyPage.test.tsx` 寫入失敗測試：房間卡保留房碼、兩位玩家、觀眾及狀態，同時帶競技卡語義 class。
- [ ] 在 `RoomPage.test.tsx` 寫入失敗測試：VS 結構、準備鎖定狀態、玩家私密判定及觀眾雙方判定。
- [ ] 執行兩個測試檔確認新結構缺失而失敗。
- [ ] 最少修改 `LobbyPage.tsx`、`RoomPage.tsx`，不改 command payload、權限或顯示規則。
- [ ] 加入大廳卡、VS 座位、觀眾面板及準備轉場樣式；手機不遮擋原有控制。
- [ ] 重跑兩個測試檔及 `App.test.tsx`。
- [ ] 提交 `feat: add competitive lobby and room presentation`。

### 任務 4：節拍發射與判定回饋

- [ ] 在 `battleEffects.test.ts` 寫入失敗測試，定義現有 `LaunchGrade` 到雙語文案、色彩角色及音效角色的完整映射。
- [ ] 在 `RhythmLaunch.test.tsx` 寫入失敗測試：三層判定區、按下能量狀態、低動態替代、鍵盤及 pointer 只送一次。
- [ ] 執行測試確認缺少映射與結構而失敗。
- [ ] 實作映射、節拍跑道、衝擊層及可選 `onFeedback` 回呼；伺服器 command 完全不變。
- [ ] 修改 `RoomPage.tsx` 以判定映射顯示玩家或觀眾回饋，並把事件送往音效引擎。
- [ ] 加入倒數、判定文字、衝擊環和低動態樣式，避免全屏高速閃爍。
- [ ] 重跑 battle、room 及 App 測試。
- [ ] 提交 `feat: enhance rhythm launch feedback`。

### 任務 5：陀螺競技場視覺事件與音效

- [ ] 在 `battleEffects.test.ts` 寫入失敗測試：相鄰幀推算輕碰、高速碰撞、場邊摩擦，並以 sequence 去重。
- [ ] 在 `BattleArena.test.tsx` 寫入失敗測試：能量環、速度殘影、事件粒子層、低品質上限及低動態替代。
- [ ] 執行測試確認缺少事件及圖層而失敗。
- [ ] 實作純函式 `deriveBattleEffects`，使用距離、相對位移、角速度及半徑門檻；事件 id 綁定最新 sequence。
- [ ] 修改 `BattleArena.tsx` 渲染穩定 SVG 火花、衝擊環、場邊光和殘影，透過回呼通知音效，不重播舊 sequence。
- [ ] 修改 `MatchResult.tsx` 與 `RoomPage.tsx` 加入回合及完場演出，保持總分只在 match finished 後顯示。
- [ ] 重跑 battle、result、room 測試。
- [ ] 提交 `feat: add arena collision effects and match presentation`。

### 任務 6：響應式、效能及公開驗收

- [ ] 在 `tests/public-e2e/public-acceptance.spec.ts` 先加入失敗斷言：學生 HUD 控制、遊戲主題、發射跑道、競技場效果層及手機專注模式。
- [ ] 在本機 student build 上執行 Chromium 測試，確認新斷言在實作完成前或缺少建置時失敗。
- [ ] 完成桌面、iPad 橫／直向、手機、安全區、44px 觸控、較大文字、低動態和低品質 CSS。
- [ ] 執行 `pnpm --filter @steam-top/web test`、`typecheck`、`build:student`、`build:admin`。
- [ ] 啟動本機服務並跑 Playwright Chromium、Firefox、WebKit iPad、手機專案；修復所有回歸。
- [ ] 確認 admin 公開驗收及 Excel 匯出仍通過。
- [ ] 提交 `test: cover responsive student game experience`。

### 任務 7：發布與生產複驗

- [ ] 重新執行完整 web 測試、typecheck、student/admin build 及公開 Playwright 套件，記錄通過數。
- [ ] 檢查 `git diff --check`、`git status` 及提交歷史，確保沒有秘密、下載檔或測試產物。
- [ ] 推送 `codex/game-ui`，依現有已授權流程整合至 `main` 並觸發 GitHub Pages／Render 部署。
- [ ] 等待兩個公開網址回應新版本，使用正常 Chrome 及隔離 context 實際完成設計、雙人準備、發射、三局對戰、老師登入及 Excel 匯出。
- [ ] 只在取得新鮮測試與生產證據後回報完成。

