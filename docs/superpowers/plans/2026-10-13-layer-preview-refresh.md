# 設計室預覽簡化計劃

使用者已確認：移除實驗室及操作教學；三層俯視圖獨立顯示；3D 從上方微傾約 20°觀看，繞軸緩慢水平自轉。字體、字級、配色、正式設計與對戰資料不改動。

內聯執行，不使用曾被停止的協作代理。保留既有 `.superpowers/`，不清除 localStorage 中舊學習資料。

- [x] 先新增測試：設計室出現頂／中／底三個 SVG，每圖只有一層路徑、共用孔位、同一 viewBox，mask ID 不重複；3D 微傾預設、自轉暫停／手勢／減少動態行為；主頁不再有實驗室或教學。
- [x] `App.tsx` 移除 learning 路由、懶載入與首次提示；以 apply_patch 刪除 `features/learning` 和舊 learning E2E 程式。保留儲存資料及 Git 歷史供恢復，更新 README。
- [x] 新增 `LayerTopViews.tsx`；`TopViewSvg` 增加單層選項，保留教師等既有疊層模式；新俯視圖以最大層輪廓計算共同尺度、動態 mask 邊界，防止大板被裁切。只展示板材，不把金屬碟當作板層。
- [x] `TopPreview3D` 預設傾角 `Math.PI/9`，`CenteredModel` 使用 R3F useFrame 驅動軸向旋轉，20 秒一圈。拖動／雙指操作及隱藏分頁暫停；減少動態效果停用自轉；提供暫停按鈕。保留原有鍵盤、縮放及 WebGL 後備。
- [x] 單元、型別、完整瀏覽器回歸及 Metal 對戰驗收；只有合理因規格變更失效的舊俯視圖斷言更新，不能降低檢查強度。
- [ ] 推送驗證分支，品質／PG／安全 CI 完整通過後 fast-forward main，等 Pages 同 SHA 發布成功，再用 Chrome 驗收公開三層圖及自轉。不得再啟動第 51 場正式對戰。

驗證命令：`pnpm --filter @steam-top/web test`、`pnpm typecheck`、`pnpm test`、`pnpm exec playwright test`、`CINEMATIC_BATTLES=1 pnpm exec playwright test --config /tmp/bayblad-champion-headless-metal.config.ts tests/e2e/cinematic.spec.ts`。

核心斷言：`getByRole("img", {name:"頂層俯視圖"})`、每張圖 `layer-path` 數量 1、共同 viewBox 相等、初始 rotation x 約 0.349/y 0、自轉開啟時畫面隨時間改變而暫停後不變、正常頁面不存在「實驗室」或「開始教學」。

本機證據：web 214／214；domain 191、protocol 101、db 21、server 540、integration/CI 212 通過（32 個 PG 專用測試待 GitHub PG job）；完整 E2E 52 通過、3 cinematic 按預設跳過；另 Metal cinematic 3／3 通過。型別檢查通過。Chrome 本機實測三層獨立圖及 3D 暫停按鈕，PNG 位於專案外的 `Bayblad-preview-deployment-20261013` 證據目錄。

內聯審查：未清除儲存鍵；只有新增單層模式才改 viewBox，教師疊層預覽維持原模式；每個 SVG 使用獨立 useId；自轉停用或分頁隱藏時改 demand，避免持續 GPU 工作；限制恢復幀的 delta，避免重連顯示跳轉。畫面比較僅凍結 CSS 背景掃描線，不停止 Three.js render loop，保留「轉動時不同、暫停時完全相同」的雙向斷言。
