# GitHub Pages 前台與 Oracle A1 後台分站設計

## 目標

學生以 GitHub Pages 的公開靜態網址使用陀螺設計及對戰介面；Oracle Cloud A1 以 DuckDNS 主機名提供 HTTPS API、WSS 即時對戰、PostgreSQL、教師後台及永久記錄。兩站都必須在 iPad 及桌面瀏覽器運作。

## 公開網址

- 學生前台：`https://<github-owner>.github.io/<repository>/`
- 後台 API 及 WebSocket：`https://<duckdns-name>.duckdns.org`
- 教師後台：`https://<duckdns-name>.duckdns.org/admin/`

GitHub Pages 只提供靜態檔案，不代表 Oracle 後台的網域。DuckDNS A 記錄指向 Oracle 保留公開 IP，Caddy 自動申請及更新 TLS 憑證。

## 前台分割

同一網頁程式產生兩個已審核輸出：

1. `student` 輸出供 GitHub Pages，包含設計工具、房間大廳、玩家區、觀戰區、發射節拍及賽後分數。
2. `admin` 輸出由 Oracle Caddy 提供，包含教師登入、對戰紀錄、排行、使用統計、參數表現及 Excel 匯出。

兩者不共享網頁導覽入口；GitHub Pages 不顯示教師後台連結。

## 身份及安全邊界

- 教師登入只發生在 DuckDNS 同源頁面，使用 `Secure`、`HttpOnly`、`SameSite=Strict` Cookie 及 CSRF 保護。
- GitHub Pages 學生前台不取得教師 Cookie，亦不將管理憑證寫入 localStorage。
- 學生連線使用短期、不透明、可輪換的簽署會話憑證；HTTP 以 Authorization header 傳送，Socket.IO 以 handshake auth 傳送。
- 瀏覽器只保存不含學生姓名、班別或學號的不透明憑證。iClass 或裝置對應資料只存在伺服器。
- 識別失敗時仍可以訪客身份進行對戰。IP 僅作限速及安全稽核，不當作穩定學生身份；無法在網頁取得 MAC address。

## 跨站通訊

- 後台只允許已設定的 GitHub Pages 精確 origin，不使用 `*` CORS。
- 允許的 method、header 及 request body 大小均採白名單。
- WebSocket handshake 檢查 Origin 及短期憑證；斷線重連不可擴大房間人數或重複計分。
- GitHub Pages 編譯時注入精確 API origin 及 repository base path，執行時不以 query string 改寫。
- 學生前台 CSP 只允許自身靜態資源及指定的 HTTPS/WSS 後台。

## 發布及部署

- GitHub Actions 先執行 lint、typecheck、單元、PostgreSQL、瀏覽器及安全測試。
- 通過後產生 GitHub Pages 學生靜態 artifact，以 GitHub Pages 官方 action 發布。
- 後台 server、admin web 及 database 影像以 `linux/amd64` 及 `linux/arm64` 建置，以不可變 digest 取用。
- 每個平台的 manifest、SLSA provenance 及 SPDX SBOM 綁定到發布證據，禁止用可變 tag 作為部署授權。
- Oracle A1 執行 Ubuntu 24.04 ARM64、Docker Compose、Caddy 及 PostgreSQL 持久 volume；只開放 22、80 及 443。
- DuckDNS token、GitHub token、資料庫密碼及簽署金鑰不進入 repository、image、artifact 或 log。

## 失敗處理

- GitHub Pages 無法連接後台時，顯示「伺服器暫時無法連線」，保留未送出的本機設計，不偽造對戰成功。
- 身份憑證過期時只重建訪客或 iClass 會話，不重複提交計分。
- DuckDNS 更新或 TLS 失敗時後台停止對外提供未加密 API，不降級為 HTTP。
- 資料庫備份、還原、發布回滾及部署收據沿用現有 fail-closed 流程。

## 驗收準則

1. GitHub Pages repository 子路徑直接開啟、重新載入及靜態資源均正常。
2. iPad Safari 及桌面 Chromium 可建立房間、兩人準備、發射、觀戰及完成計分。
3. 未授權 origin、過期憑證、偽造 WebSocket 及跨站教師 mutation 全部被拒絕。
4. 教師後台只在 DuckDNS 同源下登入，可查閱永久紀錄、統計及匯出 Excel。
5. Oracle ARM64 實機只取用已核對 provenance、SBOM 及 digest 的影像，生產 smoke test 包含 HTTPS、WSS、教師登入及資料庫收據。
