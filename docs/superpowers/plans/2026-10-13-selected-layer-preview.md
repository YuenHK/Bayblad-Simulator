# 選層預覽與操作列更新

已批准：只顯示編輯層俯視圖，分解板材放大 3 倍，3D 預設 X=180°，三個按鈕集中排列。保留字體、配色、設計資料及所有操作功能。

- [ ] 先改 LayerTopViews、TopViewSvg、工作台 E2E 測試，驗證選層唯一、孔位及共同尺度、分解 scale(2.16 1.02)、預設 Math.PI。
- [ ] 執行測試確認失敗。DesignerPage 傳 selectedLayerId 和 scale=3；LayerTopViews 篩選所選層。ExplodedView 新增預設 scale=1，僅設計室放大，按尺寸調整邊界及間距。
- [ ] makerWorkbench.css 移除參戰按鈕 order:3 和自動左邊距；同列拉伸對齊、集中靠左，窄螢幕換行；单層俯視圖一欄大圖。
- [ ] 執行前端全部測試、型別及 Metal 預覽／工作台 E2E。確認手機／平板／桌面、尺寸不裁切、三個按鈕保持同列同高。
- [ ] 提交及部署 Pages；核實精確版本、公開介面和截圖。
