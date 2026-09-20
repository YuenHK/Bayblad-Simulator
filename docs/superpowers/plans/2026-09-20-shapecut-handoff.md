# ShapeCut 一鍵傳送（使用者已批准）

## 規格
- 即時計算下方統一操作列：參戰、傳送至 ShapeCut、下載 STL。保留字體與配色，按鈕同高並可換行。
- STL 只含三層 6 mm 板材，不含五金。ShapeCut 匯入後停在材料選擇，不自動製作。
- 使用新分頁與 postMessage，在瀏覽器內傳送，不上傳伺服器。保留 STL 下載後備。
- 不覆寫 ShapeCut 原有儲存專案，不修改切片或發射器幾何。
- 額外的「停止等待」僅清理傳送端等待狀態，不聲稱撤回已送出的板材；提示使用者到 ShapeCut 確認。

## 傳送協定 v1
URL：同源 `/ShapeCut/#bayblad-transfer=<UUID>`。訊息共用 `protocol: bayblad-shapecut`、`version: 1`、`token`，type 為 ready / stl / accepted / error。
stl 附固定 fileName `bayblad-3layers-6mm-mm.stl` 與 ArrayBuffer bytes，最大 20 MiB。雙方核對 origin、對方 Window 與 token。接收方每 500 ms 發 ready；限時 90 秒，只接收一次。accepted 在材料選擇畫面就緒後才發出。

## 實作與驗收順序
1. 先寫失敗測試，ShapeCut 接收端獨立實作；陀螺端實作傳送生命週期及統一操作列。
2. 驗證錯誤 origin/source/token、重複訊息、彈窗阻擋、逾時、取消、檔案格式/大小、已有儲存專案。
3. 單元測試、型別檢查、建置與桌面/窄屏瀏覽器測試；兩個正式建置同源跨頁實際傳送驗收。
4. 規格/品質審查後先部署 ShapeCut，再部署陀螺端；核實公開網站匯入流程。
5. 軟件傳送驗收不等同 iPad 真機或實物試切驗收。
