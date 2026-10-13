# STEAM 陀螺模擬器｜Bayblad Simulator

以香港中學 Maker／STEAM 課堂為背景的開源設計及線上對戰平台。學生設計三層陀螺，觀察重量、重心與相對能力值，再以節拍發射與真人或電腦玩家對戰；教師可查看紀錄、分析及匯出 Excel。

這是教學模擬與遊戲，不是實物安全認證、精密工程求解器或官方爆旋陀螺產品。預測與動畫不能代替實物測試。

## 線上測試網站

| 入口 | 用途 |
| --- | --- |
| [學生測試網站](https://yuenhk.github.io/Bayblad-Simulator/) | 設計、預覽、房間及對戰，不要求手動輸入個人資料 |
| [教師後台](https://bayblad-simulator-api.onrender.com/admin/) | 新版使用共用口令 `admin`；非私人帳戶，包含學生資料，勿公開轉載 |
| [後端健康檢查](https://bayblad-simulator-api.onrender.com/health/ready) | 伺服器、資料庫及遷移就緒狀態 |
| [建置與測試紀錄](https://github.com/YuenHK/Bayblad-Simulator/actions) | GitHub Actions 結果 |

公開站可能保留訪客對戰紀錄，請勿輸入真實學生或機密資料。請在自己的環境進行大量／負載測試，不要對共用測試站施加壓力。

Render 免費後端閒置後可能需要啟動時間。學生端單次身份請求最多等候 10 秒，暫時失敗時相隔 2 秒自動重試，最多六次；顯示喚醒提示，最終失敗可按「重試連線」。這不是持續保活，也不保證免費平台隨時即時可用。

## 學生功能

- **三層設計**：基礎造型提供圓形、多邊形、星形、波浪形，可調整直徑、角數、圓角、旋轉及排序；自定造型支援自由繪畫、左右／上下及多等分鏡射。
- **裝配**：三層共用螺絲配置；金屬圓碟只放最底層下方，由軸心夾住，不讓固定螺絲穿過金屬碟。
- **預覽及驗證**：頂／中／底三層俯視圖獨立、相同比例顯示，保留各層輪廓與孔位；另有分解及 3D。3D 預設從上方微傾約 20°觀看，20 秒水平自轉一圈，可暫停，拖動／雙指操作時暫停；減少動態效果或隱藏分頁時不自轉。即時計算重量、平面重心、轉動慣量及能力值，提示不符合課堂規格的參數。
- **房間與觀賽**：兩個對戰席位、觀賽區、房間碼與大廳；玩家入房或坐上對戰席時會自動上載目前設計並準備一次，觀眾不會自動準備。首場完成後停在結果，返回房間再按準備才開新場；失敗時顯示錯誤並可手動重試。房主可讓出席位。觀賽區仍受主機效能及防濫用限制，不能理解成無限容量。
- **節拍發射**：判定越準，初始轉速及推力倍率越高；沒有判定也以 Miss／最低倍率發射。玩家只看自己的判定，觀眾可看雙方判定。
- **完整演出**：單場 10 秒；0–8 秒反覆衝撞及彈開，附火花、電光及殘影；8–9 秒召喚生肖；9–10 秒決勝撞擊，敗方碎裂，平手不碎裂。首輪即結算，平手亦直接結束；返回房間後由玩家重新準備才開始另一場。勝方得 1 對戰分，原挑戰分計算保留，舊兩勝紀錄仍可讀取。這是確定性的同步視覺演出，不改變權威物理勝負。生肖模型為簡化幾何風格。
- **參戰規格**：總重量不超過 60 克即可；直徑、孔位、材料頸部及金屬碟外露不再作課程准入阻擋。仍保留輸入範圍、有效幾何與有限數值檢查。遊戲准入不代表實物可安全製作。
- **賽後及重賽**：整場完成後顯示對戰分、挑戰分及總分；返回同房再次準備。學生對戰端不顯示排行榜或自動戰術建議。
- **房間自動關閉**：房主主動離房或切換到設計室／大廳會立即關房；最後一名連線真人主動離開也會關房，電腦玩家不能保留空房。關閉分頁的離頁通知有 10 秒重連緩衝，重新整理成功便取消；純網絡斷線保留 120 秒，房主最終逾時後關房。瀏覽器不保證離頁通知送達，未送達時使用原有逾時清理後備。進行中的對戰可取消，已完成紀錄及分數不刪除。
- **電腦玩家**：房主可加入／移除；隨機發射判定，先按全部歷史已完成真人賽事的累計總分（對戰分＋挑戰分）選出學生排行榜第一名，再使用該學生的最高分場次合規設計，不按全站單場最高分或人氣選擇。身份採用與教師排行榜相同的歷史 canonical 快照，兩席位都納入，電腦及未完成賽事排除。累計同分按教師表格的名稱／身份 ID 排序；代表場次同分取較新完成紀錄，再按賽事 ID／席位排序。每次電腦重新準備時更新，不受教師畫面的日期或班別篩選影響；無可用紀錄時使用預設設計。

## 下載三層板材 STL → ShapeCut

在設計室「即時計算」下方按 **「傳送至 ShapeCut（供 雷射切割)」**，新分頁會自動接收三層板材，無須下載再上載。接收後仍由你選擇 **6 mm 板材**、按「開始製作」，核對分層預覽後輸出 DXF。手機的結果及匯出區同樣保持可用。

傳送只在兩個瀏覽器分頁之間進行，不上傳模型到伺服器；接收分頁不會覆寫 ShapeCut 原有儲存專案。若新分頁被瀏覽器阻擋、已關閉或傳送逾時，可重試，或按 **「下載 STL（供 3D打印)」** 後在 [ShapeCut](https://yuenhk.github.io/ShapeCut/) 手動選擇檔案。「停止等待」只停止本頁等候；已送出的板材仍可能在 ShapeCut 匯入，請到該分頁確認。

- 單一二進位 STL，只含頂／中／底三層板材；每層厚 6 mm，總高 18 mm，數值單位為 mm。STL 格式本身不記錄單位及顏色。
- 保留本設計的輪廓、旋轉、上下排序、軸孔與螺絲孔；不含螺絲、軸心或金屬貼片。布林聯集去除板材間的內部接觸面，不留假空隙。
- 在瀏覽器本機運算；首次下載才載入幾何引擎。不需要後端連線，亦不會上傳設計檔。未完成／無效數值欄位會禁止下載；60 g 上限仍只限制參戰。
- **ShapeCut 的 DXF 不保證原樣複製所有孔位**：它會簡化輪廓、判定可保留特徵並加入發射器結構，部分裝飾孔可能被省略。請檢查各層輪廓、孔位、單位、材料厚度及刀縫，先試切再正式製作。
- 2026-09-20 已以預設設計的實際下載檔，通過 ShapeCut 程式碼的三層精確切片檢查；這不是實體裝配或雷射加工安全認證。

STL 匯出採用 [Manifold](https://github.com/elalish/manifold) 3.5.3，按需載入其 WASM 幾何引擎；其 Apache-2.0 授權副本隨網站置於 [`licenses/manifold-3d.txt`](apps/web/public/licenses/manifold-3d.txt)。本專案自身的 MIT 授權不取代第三方授權。

## 教師功能與身份限制

後台分為總覽、對戰紀錄、學生排行榜及高分設計四頁籤，提供共用口令入口、對戰紀錄、設計參數、日期時間、身份／裝置狀態、排行榜、使用量及參數分析。Excel 含六張工作表：對戰紀錄、逐輪結果、陀螺參數、身份及裝置狀態、使用量統計、參數分析。統計中較高分的參數不是保證獲勝的物理最佳解。

三個紀錄／設計列表直接展示歷史靜態 3D（包括自定輪廓及孔位）；排行榜代表設計取目前篩選範圍內最高分場次，不代表唯一使用過的設計。新版移除改密碼與永久刪除 HTTP 入口，仍保留 session、CSRF、同源限制及登入限流。使用者已選擇以簡單共用口令開放現有資料與匯出；這不是個別教師身份驗證。

一般網頁不能直接讀取 iPad 系統裝置名稱、MAC 位址或其他網站的瀏覽歷史。專案支援受信任的 iClass／WebClip 整合，但需要部署者配置及校方配合；2026-09-08 核實的公開後端使用 `guest-only-explicit` 訪客模式。

Cookie／不透明憑證可延續同一瀏覽器身份；清除儲存或關閉無痕工作階段後不能保證保留。IP／User-Agent 只供有限診斷，不能可靠當成班別學號。開源授權不包含學生資料或存取正式後台的權利。

## 系統架構

```mermaid
flowchart LR
    G[GitHub Pages 靜態前端] --> S[學生：React / Three.js]
    S <-->|HTTPS / Socket.IO| A[Render：Fastify]
    T[教師後台] -->|登入、統計、Excel| A
    A --> D[PostgreSQL / Drizzle]
    A --> P[Planck 二維物理求解]
    P --> C[10 秒軌跡與單場演出時間表]
    C --> A
```

| 目錄 | 職責 |
| --- | --- |
| `apps/web` | 學生／教師入口、設計、房間、圖表與 3D 演出 |
| `apps/server` | 身份、登入、即時事件、發射、物理、紀錄、分析、Excel |
| `packages/domain` | 設計、幾何、質量、課堂規則及能力模型 |
| `packages/protocol` | Zod 驗證與版本化資料契約 |
| `packages/db`、`drizzle` | 資料庫模型及遷移 |
| `tests` | 整合、端對端、安全、公開站及負載測試 |
| `scripts`、`infra` | 部署、備份、還原及稽核工具 |

伺服器重新驗證設計、決定勝負及計分，前端負責呈現。GitHub Pages 不能單獨取代即時後端和資料庫。

## 運算原理

從參數產生輪廓 → 計算淨面積、質量、重心與慣量 → 檢查重量上限 → 相對能力值＋發射倍率 → 伺服器物理求解 → 10 秒同步 3D 演出及單場結算。

**內部物理求解時間不等於畫面播放時間**；召喚獸及鏡頭不重新決定勝負。完整公式、判定門檻及計分見 [架構與運算原理](docs/technical-guide.zh-Hant.md)。

## 本機開發與測試

需要 Git、Node.js 24 或以上及 pnpm 11.19.0。部分部署契約測試另需 Ruby、Bash、OpenSSH；PostgreSQL／容器驗收需要相應資料庫及 Docker 環境。

```bash
git clone https://github.com/YuenHK/Bayblad-Simulator.git
cd Bayblad-Simulator
corepack enable
corepack prepare pnpm@11.19.0 --activate
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm lint
pnpm typecheck
pnpm test
pnpm test:e2e
```

`test:e2e` 自動啟動測試用 Fastify／Socket.IO、學生 production build 預覽及教師頁，不需要正式帳密。這套測試伺服器不可當正式服務公開。`pnpm dev` 是工作區開發入口，不會自動供應完整正式資料庫、身份與部署環境；首次驗證整体流程建議先用 `test:e2e`。

```bash
# 本機完整 10 秒單場人機演出
pnpm test:cinematic

# 公開學生站：模擬兩次暫時失敗，再連真正 API
pnpm exec playwright test --config playwright.public.config.ts --project chromium-desktop --grep 'cold server'

# 公開人機驗收：會新增測試對戰紀錄
CINEMATIC_BATTLES=1 pnpm exec playwright test --config playwright.public.config.ts --project chromium-desktop --grep 'computer battle'
```

教師公開站測試須明確設定 `PUBLIC_ADMIN_ACCEPTANCE=1` 才執行；未設定則跳過，不是通過。共用口令為 `admin`，請勿在測試報告或截圖公開學生資料。其他入口包括 `test:security`、`test:load`，執行前閱讀其設定與環境要求。

## 部署與資料保存

目前測試站為 GitHub Pages＋Render Docker＋PostgreSQL。Fork 後應建立自己的服務及密鑰，不應沿用本專案正式後台。

1. 配置自己的 HTTPS 後端、PostgreSQL、Origins 與獨立簽章密鑰，參考 [環境設定](docs/operations/environment.md) 及 [.env.example](.env.example)。
2. 後端參考 `Dockerfile.server`、`scripts/migrate-and-start.sh`、`apps/server/src/config.ts`。映像 build 需要核實的 Node digest；須明確配置遷移啟動流程，不能假定預設 CMD 會自動遷移。
3. 前端部署見 [.github/workflows](.github/workflows)，設定自己的 `STUDENT_API_ORIGIN` 及後端允許的學生 Origin。
4. 驗證健康檢查、身份、完整對戰及教師匯出；部署成功不是功能驗收的替代品。

自管主機的受保護發布、備份與還原見 [發布流程](docs/operations/release.md) 及 [持久化工作](docs/operations/persistence-jobs.md)。此路徑與現有 Render 不同，也不代表已為你的 Fork 配置完成。永久保留需要持久化資料庫、備份與還原驗證，不能靠免費容器檔案系統保證。

## 驗收狀態與限制

2026-09-08，`00c2c89` 已部署至 Render 及 Pages。公開 Chromium 完成人機整場對戰、返回同房重賽及喚醒恢復；教師登入、統計與 Excel 補測通過；前端 152 項測試通過。既有跨瀏覽器紀錄見 [驗收紀錄](docs/operations/acceptance-2026-09-07.md)。

實體 iPad、音效聆聽、動畫美術品質、真實班級負載及免費平台長期可用性仍須另測。[該版本 CI](https://github.com/YuenHK/Bayblad-Simulator/actions/runs/34171866024) 的 quality 通過、production-security 失敗，不能寫成全部通過。最新結果以 Actions 為準。

## 開源授權及安全

本專案有權授權的自有程式及隨附說明採用 [MIT License](LICENSE)。允許公開閱讀、使用、複製、修改、合併、發布、再散布、再授權及商業使用；複製或散布全部或重要部分時須保留版權及授權聲明。軟體按現狀提供，不作擔保。標準來源：[Open Source Initiative](https://opensource.org/license/mit)，以本庫 `LICENSE` 英文條款為準。

第三方套件、商標及外部素材各自保留其條款；學生資料、正式資料庫、憑證或未由本專案擁有權利的課程文件不在授權範圍。見 [第三方聲明](THIRD_PARTY_NOTICES.md)。

舊提交曾含部署密碼字串。新版移除目前檔案的明碼，但 Git 歷史／複本仍可能保留，部署者必須輪換已曝光憑證；單純刪除檔案不會恢復保密。本次文件更新不會自行修改線上密碼或改寫歷史。

歡迎提交不含個人資料的 Issue／Pull Request；請勿公開帳密、學生名單、IP 紀錄或敏感匯出檔。
