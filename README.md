# STEAM 陀螺模擬器

開發與測試指令：

```bash
pnpm install --frozen-lockfile
pnpm dev
pnpm lint
pnpm typecheck
pnpm test
pnpm test:e2e
pnpm test:load
```

`test:e2e` 會啟動實際 Fastify/Socket.IO 測試伺服器及 production build 預覽；`test:load` 會以兩名玩家及 20 名觀眾完成一場對戰並檢查廣播一致性。
