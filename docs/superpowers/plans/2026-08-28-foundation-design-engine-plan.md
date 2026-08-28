# 專案基礎與陀螺設計引擎實作計劃

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推薦）或 superpowers:executing-plans 逐任務實現此計劃。步驟使用復選框（`- [ ]`）語法來跟蹤進度。

**目標：** 從空白資料夾建立可測試的參數化三層陀螺設計器，提供規格驗證、重量／性能預測及 3D 預覽。

**架構：** monorepo 以 `packages/domain` 保存純函式幾何、質量和規格規則，`apps/web` 只處理互動及顯示。前後端日後共用同一套 Zod schema 及 domain 函式，避免規格判定分歧。

**技術棧：** Node.js 24、pnpm 11、TypeScript 7、React 19、Vite 8、Zod 4、Three.js、React Three Fiber、Vitest 4、Playwright 1。

---

## 檔案結構

- `package.json`：根工作指令及版本約束
- `pnpm-workspace.yaml`：workspace 定義
- `tsconfig.base.json`：共用 TypeScript 設定
- `apps/web/`：學生及教師響應式網頁
- `apps/web/src/features/designer/`：設計表單、狀態及預覽
- `packages/domain/src/design.ts`：陀螺設計資料型別及 schema
- `packages/domain/src/geometry.ts`：參數化形狀和面積
- `packages/domain/src/mass.ts`：重量、重心和轉動慣量
- `packages/domain/src/rules.ts`：課程規格驗證
- `packages/domain/src/performance.ts`：相對性能預測
- `tests/e2e/designer.spec.ts`：設計器端到端測試

### 任務 1：初始化 Git 及 TypeScript monorepo

**文件：**
- 建立：`.gitignore`
- 建立：`package.json`
- 建立：`pnpm-workspace.yaml`
- 建立：`tsconfig.base.json`
- 建立：`packages/domain/package.json`
- 建立：`packages/domain/tsconfig.json`

- [ ] **步驟 1：初始化版本庫**

執行：

```bash
git init
git branch -M main
```

預期：`git status` 顯示空的 `main` 分支。

- [ ] **步驟 2：建立根設定**

`package.json`：

```json
{
  "name": "steam-spinning-top-simulator",
  "private": true,
  "packageManager": "pnpm@11.19.0",
  "engines": { "node": ">=24" },
  "scripts": {
    "dev": "pnpm --parallel --filter './apps/*' dev",
    "build": "pnpm -r build",
    "lint": "pnpm -r lint",
    "typecheck": "pnpm -r typecheck",
    "test": "pnpm -r test",
    "test:e2e": "playwright test"
  },
  "devDependencies": {
    "@playwright/test": "1.62.1",
    "typescript": "7.0.2",
    "vitest": "4.1.11"
  }
}
```

`pnpm-workspace.yaml`：

```yaml
packages:
  - apps/*
  - packages/*
```

`tsconfig.base.json`：

```json
{
  "compilerOptions": {
    "target": "ES2024",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "skipLibCheck": true
  }
}
```

`.gitignore`：

```gitignore
node_modules/
dist/
coverage/
playwright-report/
test-results/
.env
.env.*
!.env.example
tmp/
```

`packages/domain/package.json`：

```json
{
  "name": "@steam-top/domain",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "test": "vitest run", "typecheck": "tsc --noEmit", "build": "tsc --noEmit", "lint": "tsc --noEmit" },
  "dependencies": { "zod": "4.4.3" },
  "devDependencies": { "typescript": "7.0.2", "vitest": "4.1.11" }
}
```

`packages/domain/tsconfig.json`：

```json
{ "extends": "../../tsconfig.base.json", "include": ["src/**/*.ts"] }
```

- [ ] **步驟 3：安裝工作區依賴**

執行：`pnpm install`

預期：安裝成功並產生 `pnpm-lock.yaml`；型別檢查由任務 2 建立 source 後開始執行。

- [ ] **步驟 4：Commit**

```bash
git add .gitignore package.json pnpm-workspace.yaml tsconfig.base.json pnpm-lock.yaml packages/domain
git commit -m "chore: initialize simulator monorepo"
```

### 任務 2：定義設計 schema 及預設設計

**文件：**
- 建立：`packages/domain/src/design.ts`
- 建立：`packages/domain/src/design.test.ts`
- 建立：`packages/domain/src/index.ts`

- [ ] **步驟 1：編寫失敗的 schema 測試**

```ts
import { describe, expect, it } from "vitest";
import { designSchema, makeDefaultDesign } from "./design";

describe("designSchema", () => {
  it("accepts the three-layer default design", () => {
    const design = makeDefaultDesign();
    expect(designSchema.parse(design).layers).toHaveLength(3);
  });

  it("rejects a fourth layer", () => {
    const design = makeDefaultDesign();
    expect(() => designSchema.parse({ ...design, layers: [...design.layers, design.layers[0]] })).toThrow();
  });
});
```

- [ ] **步驟 2：執行測試確認失敗**

執行：`pnpm --filter @steam-top/domain test -- design.test.ts`

預期：FAIL，找不到 `./design`。

- [ ] **步驟 3：實作 schema**

```ts
import { z } from "zod";

export const layerSchema = z.object({
  id: z.string(),
  position: z.enum(["top", "middle", "bottom"]),
  shape: z.enum(["circle", "polygon", "star", "wave"]),
  points: z.number().int().min(3).max(16),
  diameterMm: z.number().min(20).max(80),
  cornerRoundness: z.number().min(0).max(1),
  rotationDeg: z.number().min(0).max(359),
  color: z.string().regex(/^#[0-9a-f]{6}$/i)
});

export const designSchema = z.object({
  id: z.string(),
  name: z.string().min(1).max(40),
  layers: z.tuple([layerSchema, layerSchema, layerSchema]),
  screwLayout: z.object({ count: z.number().int().min(3).max(8), radiusMm: z.number().min(5).max(25), rotationDeg: z.number().min(0).max(359) }),
  metalDiscDiameterMm: z.union([z.literal(0), z.number().min(10).max(55)])
});

export type TopDesign = z.infer<typeof designSchema>;

export function makeDefaultDesign(): TopDesign {
  return {
    id: crypto.randomUUID(), name: "未命名陀螺",
    layers: ["top", "middle", "bottom"].map((position, index) => ({
      id: crypto.randomUUID(), position: position as "top" | "middle" | "bottom",
      shape: "circle", points: 6, diameterMm: 50, cornerRoundness: 0.5,
      rotationDeg: 0, color: ["#2563eb", "#60a5fa", "#bfdbfe"][index]!
    })) as TopDesign["layers"],
    screwLayout: { count: 4, radiusMm: 18, rotationDeg: 0 },
    metalDiscDiameterMm: 0
  };
}
```

- [ ] **步驟 4：執行測試驗證通過**

執行：`pnpm --filter @steam-top/domain test -- design.test.ts`

預期：2 tests PASS。

- [ ] **步驟 5：Commit**

```bash
git add packages/domain/src
git commit -m "feat: define spinning top design schema"
```

### 任務 3：參數化形狀與面積

**文件：**
- 建立：`packages/domain/src/geometry.ts`
- 建立：`packages/domain/src/geometry.test.ts`

- [ ] **步驟 1：編寫失敗測試**

```ts
it("generates a closed safe polygon inside the requested diameter", () => {
  const vertices = makeLayerVertices({ shape: "polygon", points: 6, diameterMm: 60, cornerRoundness: 0.4, rotationDeg: 0 });
  expect(vertices.length).toBeGreaterThanOrEqual(24);
  expect(maxDiameter(vertices)).toBeCloseTo(60, 5);
  expect(polygonArea(vertices)).toBeGreaterThan(2000);
});

it("keeps a rounded star free of narrow necks", () => {
  const vertices = makeLayerVertices({ shape: "star", points: 6, diameterMm: 55, cornerRoundness: 0.7, rotationDeg: 15 });
  expect(minRadialThickness(vertices)).toBeGreaterThanOrEqual(6);
});
```

- [ ] **步驟 2：執行並確認失敗**

執行：`pnpm --filter @steam-top/domain test -- geometry.test.ts`

預期：FAIL，`makeLayerVertices` 未定義。

- [ ] **步驟 3：實作形狀生成介面及演算法**

```ts
export type Point = Readonly<{ x: number; y: number }>;

export function makeLayerVertices(input: Pick<Layer, "shape" | "points" | "diameterMm" | "cornerRoundness" | "rotationDeg">): Point[] {
  const outer = input.diameterMm / 2;
  const count = input.shape === "circle" ? 64 : Math.max(input.points * 8, 32);
  return Array.from({ length: count }, (_, i) => {
    const angle = (i / count) * Math.PI * 2 + input.rotationDeg * Math.PI / 180;
    const wave = radialFactor(input.shape, input.points, angle, input.cornerRoundness);
    return { x: Math.cos(angle) * outer * wave, y: Math.sin(angle) * outer * wave };
  });
}
```

同檔案實作 `radialFactor`、`polygonArea`、`maxDiameter`、`minRadialThickness`，以純函式回傳有限數值；所有輸入先經 `layerSchema` 驗證。

- [ ] **步驟 4：加入四種形狀快照數值測試並跑全套 domain 測試**

執行：`pnpm --filter @steam-top/domain test`

預期：所有 geometry/design 測試 PASS，沒有 `NaN`。

- [ ] **步驟 5：Commit**

```bash
git add packages/domain/src/geometry*
git commit -m "feat: generate safe parametric layer geometry"
```

### 任務 4：重量、重心、慣量及規格驗證

**文件：**
- 建立：`packages/domain/src/mass.ts`
- 建立：`packages/domain/src/mass.test.ts`
- 建立：`packages/domain/src/rules.ts`
- 建立：`packages/domain/src/rules.test.ts`

- [ ] **步驟 1：編寫邊界測試**

```ts
it.each([[60, true], [60.01, false]])("validates diameter %s", (diameterMm, valid) => {
  const design = withAllLayerDiameters(makeDefaultDesign(), diameterMm);
  expect(validateDesign(design).valid).toBe(valid);
});

it("rejects an off-profile bottom metal disc", () => {
  const design = { ...makeDefaultDesign(), metalDiscDiameterMm: 55 };
  design.layers[2].diameterMm = 50;
  expect(validateDesign(design).issues).toContainEqual(expect.objectContaining({ code: "METAL_DISC_OUTSIDE_BOTTOM" }));
});
```

- [ ] **步驟 2：執行並確認失敗**

執行：`pnpm --filter @steam-top/domain test -- mass.test.ts rules.test.ts`

預期：FAIL，質量及驗證函式未定義。

- [ ] **步驟 3：實作材料常數及計算結果**

```ts
export const MATERIALS = {
  acrylicDensityGPerMm3: 0.00118,
  layerThicknessMm: 6,
  metalDensityGPerMm3: 0.00785,
  metalDiscThicknessMm: 1
} as const;

export type MassProperties = Readonly<{
  totalMassG: number;
  centerOfMassMm: Point;
  polarMomentGmm2: number;
}>;
```

以多邊形面積／形心公式計算三層，金屬貼片使用置中圓盤公式；中央孔及共用螺絲孔從面積和慣量扣除。

- [ ] **步驟 4：實作規格問題代碼**

```ts
export type RuleIssueCode =
  | "DIAMETER_OVER_60"
  | "HEIGHT_OVER_40"
  | "WEIGHT_OVER_60"
  | "SCREW_OUTSIDE_LAYER"
  | "SCREW_HITS_AXLE"
  | "NECK_TOO_THIN"
  | "METAL_DISC_OUTSIDE_BOTTOM";
```

`validateDesign` 回傳 `{ valid, issues, massProperties }`，所有 issue 含 `layerId`、`field` 及繁體中文 `message`。

- [ ] **步驟 5：跑邊界與全套測試**

執行：`pnpm --filter @steam-top/domain test`

預期：60 mm／60 g 剛好通過，超出 0.01 即失敗；全部測試 PASS。

- [ ] **步驟 6：Commit**

```bash
git add packages/domain/src/mass* packages/domain/src/rules*
git commit -m "feat: calculate mass and enforce course rules"
```

### 任務 5：相對性能預測模型

**文件：**
- 建立：`packages/domain/src/performance.ts`
- 建立：`packages/domain/src/performance.test.ts`

- [ ] **步驟 1：編寫單調性測試**

```ts
it("raises spin-duration score when mass moves outward without changing total mass", () => {
  const inner = fixtureWithMassRadius(12);
  const outer = fixtureWithMassRadius(22);
  expect(predictPerformance(outer).spinDuration).toBeGreaterThan(predictPerformance(inner).spinDuration);
});

it("penalizes stability when the center of mass is offset", () => {
  expect(scoreStability({ offsetMm: 2 })).toBeLessThan(scoreStability({ offsetMm: 0 }));
});
```

- [ ] **步驟 2：執行確認失敗**

執行：`pnpm --filter @steam-top/domain test -- performance.test.ts`

預期：FAIL，預測函式未定義。

- [ ] **步驟 3：實作可版本化模型**

```ts
export const PERFORMANCE_MODEL_VERSION = "1.0.0";

export type PerformancePrediction = Readonly<{
  speed: number;
  spinDuration: number;
  stability: number;
  impactResistance: number;
  modelVersion: string;
}>;
```

每項分數限制在 0–100，輸入只取已計算的質量、慣量、輪廓圓度、最小頸寬及重心偏移；不輸出學生改良建議。

- [ ] **步驟 4：執行測試及建立 12 個校準 fixture**

執行：`pnpm --filter @steam-top/domain test -- performance.test.ts`

預期：單調性、範圍及模型版本測試 PASS。

- [ ] **步驟 5：Commit**

```bash
git add packages/domain/src/performance*
git commit -m "feat: predict relative spinning top performance"
```

### 任務 6：建立 React 設計器表單

**文件：**
- 建立：`apps/web/package.json`
- 建立：`apps/web/vite.config.ts`
- 建立：`apps/web/src/main.tsx`
- 建立：`apps/web/src/features/designer/DesignerPage.tsx`
- 建立：`apps/web/src/features/designer/LayerControls.tsx`
- 建立：`apps/web/src/features/designer/AssemblyControls.tsx`
- 建立：`apps/web/src/features/designer/useDesigner.ts`
- 測試：`apps/web/src/features/designer/DesignerPage.test.tsx`

- [ ] **步驟 1：建立 web package manifest**

```json
{
  "name": "@steam-top/web",
  "private": true,
  "type": "module",
  "scripts": { "dev": "vite", "build": "vite build", "test": "vitest run", "typecheck": "tsc --noEmit", "lint": "tsc --noEmit" },
  "dependencies": {
    "@react-three/fiber": "9.7.0", "@steam-top/domain": "workspace:*", "react": "19.2.8", "react-dom": "19.2.8", "three": "0.185.1"
  },
  "devDependencies": {
    "@testing-library/jest-dom": "7.0.1", "@testing-library/react": "16.3.3", "@testing-library/user-event": "14.6.6",
    "@types/react": "19.2.18", "@types/react-dom": "19.2.5", "@types/three": "0.185.4", "jsdom": "30.0.1", "typescript": "7.0.2", "vite": "8.2.2", "vitest": "4.1.11"
  }
}
```

執行：`pnpm install`

預期：lockfile 更新且 workspace dependency 成功連結。

- [ ] **步驟 2：編寫互動失敗測試**

```tsx
it("shows an immediate diameter warning and disables battle readiness", async () => {
  render(<DesignerPage />);
  await user.selectOptions(screen.getByLabelText("目前編輯層"), "top");
  await user.clear(screen.getByLabelText("直徑（mm）"));
  await user.type(screen.getByLabelText("直徑（mm）"), "61");
  expect(screen.getByText("最大直徑為 60 mm")).toBeVisible();
  expect(screen.getByRole("button", { name: "規格通過，可參戰" })).toBeDisabled();
});
```

- [ ] **步驟 3：執行確認失敗**

執行：`pnpm --filter @steam-top/web test -- DesignerPage.test.tsx`

預期：FAIL，頁面未建立。

- [ ] **步驟 4：建立表單及單一 reducer**

`useDesigner` 只暴露 `design`、`validation`、`prediction`、`dispatch`；每次參數更新同步呼叫 domain 純函式。使用原生 label/input/select 及適合觸控的 CSS，不以 hover 作唯一操作。

- [ ] **步驟 5：加入層次拖放及鍵盤替代操作**

提供「上移／下移」按鈕作 iPad 及鍵盤替代；重排後更新 `position`，不複製或遺失層資料。

- [ ] **步驟 6：執行元件測試**

執行：`pnpm --filter @steam-top/web test`

預期：違規提示、層次重排、共用螺絲孔及金屬貼片測試 PASS。

- [ ] **步驟 7：Commit**

```bash
git add apps/web packages/domain pnpm-lock.yaml
git commit -m "feat: add touch-friendly spinning top designer"
```

### 任務 7：俯視、分解及 3D 預覽

**文件：**
- 建立：`apps/web/src/features/designer/TopViewSvg.tsx`
- 建立：`apps/web/src/features/designer/TopPreview3D.tsx`
- 建立：`apps/web/src/features/designer/ExplodedView.tsx`
- 測試：`apps/web/src/features/designer/TopViewSvg.test.tsx`

- [ ] **步驟 1：編寫 SVG 幾何測試**

```tsx
it("renders one shared screw layout across all three layers", () => {
  render(<TopViewSvg design={fixtureDesign} />);
  expect(screen.getAllByTestId("screw-hole")).toHaveLength(fixtureDesign.screwLayout.count);
});
```

- [ ] **步驟 2：實作 SVG 俯視圖並驗證測試通過**

執行：`pnpm --filter @steam-top/web test -- TopViewSvg.test.tsx`

預期：PASS；SVG viewBox 固定，60 mm 外框不被裁切。

- [ ] **步驟 3：實作 React Three Fiber 3D 預覽**

每層使用 domain vertices 建立 `ShapeGeometry` 並擠出 6 mm；底部金屬貼片使用圓柱幾何，位置在最低亞加力膠下方。相機使用正交投影，支援單指旋轉和雙指縮放。

- [ ] **步驟 4：實作分解圖及低效能降級**

WebGL 不可用時顯示 SVG 分解圖，不阻止保存設計或規格檢查。

- [ ] **步驟 5：執行視覺元件及 build 測試**

執行：`pnpm --filter @steam-top/web test && pnpm --filter @steam-top/web build`

預期：PASS；Vite build 無 TypeScript 錯誤。

- [ ] **步驟 6：Commit**

```bash
git add apps/web/src/features/designer
git commit -m "feat: render layered 2d and 3d top previews"
```

### 任務 8：設計器端到端驗收

**文件：**
- 建立：`playwright.config.ts`
- 建立：`tests/e2e/designer.spec.ts`

- [ ] **步驟 1：編寫 iPad 尺寸 E2E 測試**

```ts
test.use({ viewport: { width: 1024, height: 768 }, hasTouch: true });

test("student creates a legal three-layer design", async ({ page }) => {
  await page.goto("/designer");
  await page.getByLabel("預設形狀").selectOption("star");
  await page.getByLabel("邊／角數").fill("6");
  await page.getByLabel("直徑（mm）").fill("58");
  await expect(page.getByRole("button", { name: "規格通過，可參戰" })).toBeEnabled();
  await expect(page.getByTestId("top-preview-3d")).toBeVisible();
});
```

- [ ] **步驟 2：執行確認測試失敗並補齊路由／可存取名稱**

執行：`pnpm test:e2e -- tests/e2e/designer.spec.ts`

預期：第一次因缺少路由或名稱 FAIL；補齊後 PASS。

- [ ] **步驟 3：加入違規、重排、金屬貼片及重新載入案例**

覆蓋 60.01 mm、60.01 g、貼片超出底層、三層重排及草稿 LocalStorage 恢復；草稿只存設計，不存身份資料。

- [ ] **步驟 4：執行階段品質閘門**

執行：`pnpm lint && pnpm typecheck && pnpm test && pnpm test:e2e`

預期：全部 PASS。

- [ ] **步驟 5：Commit**

```bash
git add playwright.config.ts tests apps/web
git commit -m "test: cover designer workflow on ipad viewport"
```
