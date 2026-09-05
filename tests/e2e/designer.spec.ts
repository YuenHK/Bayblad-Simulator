import { expect, test, type CDPSession, type Locator, type Page } from "@playwright/test";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

const DRAFT_KEY = "steam-top:designer-draft:v1";

async function replaceNumber(page: Page, label: string, value: string): Promise<void> {
  const input = page.getByLabel(label, { exact: true });
  await input.fill(value);
  await expect(input).toHaveValue(String(Number(value)));
}

async function selectLayer(page: Page, position: "top" | "middle" | "bottom"): Promise<void> {
  await page.getByLabel("目前編輯層").selectOption(position);
}

async function touch(
  session: CDPSession,
  type: "touchStart" | "touchMove" | "touchEnd",
  points: ReadonlyArray<Readonly<{ x: number; y: number; id: number }>>,
): Promise<void> {
  await session.send("Input.dispatchTouchEvent", {
    type,
    touchPoints: points.map(({ x, y, id }) => ({ x, y, id, radiusX: 3, radiusY: 3, force: 1 })),
  });
}

async function center(locator: Locator): Promise<{ x: number; y: number }> {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  return { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 };
}

test.beforeEach(async ({ page }) => {
  await page.goto("designer");
});

test("iPad student creates a legal three-layer design and loads the real 3D chunk", async ({ page, browser }) => {
  await page.getByLabel("形狀").selectOption("star");
  await replaceNumber(page, "角數", "6");
  await replaceNumber(page, "直徑（mm）", "58");
  await replaceNumber(page, "圓角程度", "0.7");
  await replaceNumber(page, "螺絲半徑（mm）", "10");

  await expect(page.getByRole("button", { name: "用此設計參戰" })).toBeEnabled();
  const tabs = page.getByRole("tablist", { name: "預覽模式" }).getByRole("tab");
  await expect(tabs).toHaveCount(3);

  const started = Date.now();
  await page.getByRole("tab", { name: "3D 預覽" }).click();
  const preview = page.getByTestId("top-preview-3d");
  await expect(preview).toBeVisible({ timeout: 15_000 });
  await expect(preview.locator("canvas")).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => preview.locator("canvas").evaluate((canvas) =>
    (canvas as HTMLCanvasElement).width > 0 && (canvas as HTMLCanvasElement).height > 0,
  ), { timeout: 15_000 }).toBe(true);
  const elapsedMs = Date.now() - started;
  const resources = await page.evaluate(() => performance.getEntriesByType("resource")
    .map((entry) => entry.name)
    .filter((name) => /TopPreview3D|three|designer/i.test(name)));
  const measurement = {
    browserVersion: browser.version(),
    elapsedMs,
    resources,
  };
  console.info(`[3d-lazy-load] ${JSON.stringify(measurement)}`);
  await test.info().attach("3d-lazy-load.json", {
    body: JSON.stringify(measurement, null, 2),
    contentType: "application/json",
  });
});

test("production 首屏不預載3D heavy chunk，選擇3D後才載入", async ({ page, request }) => {
  type Entry = { file: string; name?: string; imports?: string[]; dynamicImports?: string[] };
  const manifest = JSON.parse(await readFile(resolve(process.cwd(), "apps/web/dist/.vite/manifest.json"), "utf8")) as Record<string, Entry>;
  const collect = (root: string, includeDynamic: boolean, excluded = new Set<string>()) => {
    const found = new Set<string>(); const visit = (key: string) => { if (found.has(key) || excluded.has(key) || !manifest[key]) return; found.add(key); const entry = manifest[key]!; for (const dependency of [...(entry.imports ?? []), ...(includeDynamic ? entry.dynamicImports ?? [] : [])]) visit(dependency); }; visit(root); return found;
  };
  const sharedMain = collect("index.html", false);
  const staticMainFiles = [...sharedMain].map((key) => manifest[key]!.file).filter((file) => file.endsWith(".js"));
  const staticMainSizes = await Promise.all(staticMainFiles.map(async (file) => (await stat(resolve(process.cwd(), "apps/web/dist", file))).size));
  for (const size of staticMainSizes) expect(size).toBeLessThan(500 * 1_024);
  expect(staticMainSizes.reduce((total, size) => total + size, 0)).toBeLessThan(650 * 1_024);
  const previewKey = Object.keys(manifest).find(key => key === "src/features/designer/TopPreview3D.tsx" || manifest[key]!.name === "TopPreview3D");
  expect(previewKey).toBeDefined();
  const heavyKeys = collect(previewKey!, true, sharedMain);
  const heavyFiles = [...heavyKeys].map((key) => manifest[key]!.file);
  expect(heavyFiles.length).toBeGreaterThan(0);
  const initialResources = await page.evaluate(() => performance.getEntriesByType("resource").map((entry) => new URL(entry.name).pathname));
  for (const file of heavyFiles) expect(initialResources.some((path) => path.endsWith(`/${file}`))).toBe(false);
  const html = await (await request.get(".")).text();
  for (const file of heavyFiles) expect(html).not.toContain(file);
  await page.getByRole("tab", { name: "3D 預覽" }).click();
  await expect(page.getByTestId("top-preview-3d")).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => page.evaluate((files) => { const loaded = performance.getEntriesByType("resource").map((entry) => new URL(entry.name).pathname); return files.every((file) => loaded.some((path) => path.endsWith(`/${file}`))); }, heavyFiles)).toBe(true);
});

test("60.00 mm is valid while 60.01 mm reaches the course boundary rule", async ({ page }) => {
  await replaceNumber(page, "直徑（mm）", "60.00");
  await expect(page.getByText("最大直徑為 60 mm")).toHaveCount(0);

  await replaceNumber(page, "直徑（mm）", "60.01");
  await expect(page.getByLabel("直徑（mm）", { exact: true })).toHaveAttribute("aria-invalid", "false");
  await expect(page.getByText("最大直徑為 60 mm")).toBeVisible();
  await expect(page.getByRole("button", { name: "規格未通過，請先修正" })).toBeDisabled();
});

test("a reproducible heavy UI design crosses 60 g", async ({ page }) => {
  for (const position of ["top", "middle", "bottom"] as const) {
    await selectLayer(page, position);
    await page.getByLabel("形狀").selectOption("circle");
    await replaceNumber(page, "直徑（mm）", "80");
  }
  await page.getByLabel("金屬碟直徑").selectOption("55");

  await expect(page.getByText("總重量不可超過 60 g")).toBeVisible();
  const massText = await page.locator("dt", { hasText: /^重量$/ })
    .locator("xpath=following-sibling::dd")
    .textContent();
  const mass = Number(massText?.replace("g", "").trim());
  expect(mass).toBeGreaterThan(60);
  // Exact 60.01 g is covered by the domain unit boundary; UI presets prove the same crossing path.
});

test("a 55 mm metal disc outside the smaller bottom profile is rejected", async ({ page }) => {
  await selectLayer(page, "bottom");
  await replaceNumber(page, "直徑（mm）", "40");
  await page.getByLabel("金屬碟直徑").selectOption("55");
  await expect(page.getByText("金屬碟必須完整位於最底層下方")).toBeVisible();
});

test("real CDP touch input reorders complete layer records and announces the move", async ({ page, context }) => {
  await selectLayer(page, "middle");
  await page.getByLabel("形狀").selectOption("star");
  await replaceNumber(page, "角數", "9");
  await replaceNumber(page, "直徑（mm）", "42");
  const source = page.getByRole("button", { name: "拖動中層以重新排序" });
  const target = page.getByRole("button", { name: "拖動頂層以重新排序" });
  const sourcePoint = await center(source);
  const targetPoint = await center(target);
  const session = await context.newCDPSession(page);

  await touch(session, "touchStart", [{ ...sourcePoint, id: 1 }]);
  await touch(session, "touchMove", [{ ...targetPoint, id: 1 }]);
  await touch(session, "touchEnd", []);

  await expect(page.getByText("中層層板已移至頂層")).toBeAttached();
  await expect(page.getByLabel("目前編輯層")).toHaveValue("top");
  await expect(page.getByLabel("形狀")).toHaveValue("star");
  await expect(page.getByLabel("角數")).toHaveValue("9");
  await expect(page.getByLabel("直徑（mm）", { exact: true })).toHaveValue("42");
  const ids = await page.locator(".layer-list [data-layer-id]").evaluateAll((items) =>
    items.map((item) => (item as HTMLElement).dataset.layerId));
  expect(ids).toHaveLength(3);
  expect(new Set(ids).size).toBe(3);
});

test("draft reload preserves design only and corrupt storage falls back safely", async ({ page }) => {
  await selectLayer(page, "middle");
  await page.getByLabel("形狀").selectOption("star");
  await replaceNumber(page, "角數", "9");
  await replaceNumber(page, "直徑（mm）", "42");
  await replaceNumber(page, "螺絲數量", "6");
  await replaceNumber(page, "螺絲半徑（mm）", "18");
  await page.getByLabel("金屬碟直徑").selectOption("30");
  await page.getByRole("button", { name: "將目前層上移" }).click();
  const idsBefore = await page.locator(".layer-list [data-layer-id]").evaluateAll((items) =>
    items.map((item) => (item as HTMLElement).dataset.layerId));

  await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), DRAFT_KEY)).not.toBeNull();
  const raw = await page.evaluate((key) => localStorage.getItem(key)!, DRAFT_KEY);
  const payload = JSON.parse(raw);
  expect(Object.keys(payload).sort()).toEqual(["design", "version"]);
  expect(payload.version).toBe(1);
  expect(raw.toLowerCase()).not.toMatch(/identity|student|class|device|\bip\b|\bmac\b|cookie/);

  await page.reload();
  await expect(page.getByLabel("目前編輯層")).toHaveValue("top");
  await expect(page.getByLabel("形狀")).toHaveValue("star");
  await expect(page.getByLabel("角數")).toHaveValue("9");
  await expect(page.getByLabel("直徑（mm）", { exact: true })).toHaveValue("42");
  await expect(page.getByLabel("螺絲數量")).toHaveValue("6");
  await expect(page.getByLabel("螺絲半徑（mm）")).toHaveValue("18");
  await expect(page.getByLabel("金屬碟直徑")).toHaveValue("30");
  expect(await page.locator(".layer-list [data-layer-id]").evaluateAll((items) =>
    items.map((item) => (item as HTMLElement).dataset.layerId))).toEqual(idsBefore);

  const validDraft = await page.evaluate((key) => localStorage.getItem(key), DRAFT_KEY);
  await page.getByLabel("直徑（mm）", { exact: true }).fill("");
  await expect(page.getByLabel("直徑（mm）", { exact: true })).toHaveAttribute("aria-invalid", "true");
  expect(await page.evaluate((key) => localStorage.getItem(key), DRAFT_KEY)).toBe(validDraft);
  await page.reload();
  await expect(page.getByLabel("直徑（mm）", { exact: true })).toHaveValue("42");

  await page.evaluate((key) => localStorage.setItem(key, "{corrupt"), DRAFT_KEY);
  await page.reload();
  await expect(page.getByLabel("目前編輯層")).toHaveValue("top");
  await expect(page.getByLabel("形狀")).toHaveValue("circle");
  await expect(page.getByLabel("直徑（mm）", { exact: true })).toHaveValue("40");
});

test("real touch gestures update 3D status and WebGL context loss falls back without disabling edits", async ({ page, context }) => {
  await page.getByRole("tab", { name: "3D 預覽" }).click();
  const preview = page.getByTestId("top-preview-3d");
  const canvas = preview.locator("canvas");
  await expect(canvas).toBeVisible();
  const point = await center(preview);
  const session = await context.newCDPSession(page);
  const initialRotation = await preview.getAttribute("data-preview-rotation");
  expect(initialRotation).not.toBeNull();

  await touch(session, "touchStart", [{ x: point.x - 30, y: point.y, id: 1 }]);
  await touch(session, "touchMove", [{ x: point.x + 30, y: point.y + 10, id: 1 }]);
  await expect(page.getByRole("status")).toHaveText("正在旋轉預覽");
  await expect(preview).not.toHaveAttribute("data-preview-rotation", initialRotation!);
  await touch(session, "touchEnd", []);

  const initialZoom = await preview.getAttribute("data-preview-zoom");
  expect(initialZoom).not.toBeNull();
  await touch(session, "touchStart", [
    { x: point.x - 25, y: point.y, id: 1 },
    { x: point.x + 25, y: point.y, id: 2 },
  ]);
  await touch(session, "touchMove", [
    { x: point.x - 55, y: point.y, id: 1 },
    { x: point.x + 55, y: point.y, id: 2 },
  ]);
  await expect(page.getByRole("status")).toHaveText("正在縮放預覽");
  await expect(preview).not.toHaveAttribute("data-preview-zoom", initialZoom!);
  await touch(session, "touchEnd", []);

  await canvas.evaluate((node) => {
    const element = node as HTMLCanvasElement;
    const gl = element.getContext("webgl2") ?? element.getContext("webgl");
    gl?.getExtension("WEBGL_lose_context")?.loseContext();
  });
  await expect(page.getByText("裝置未能啟用 3D，已顯示分解圖")).toBeVisible();
  await expect(page.getByRole("img", { name: "陀螺分解圖" })).toBeVisible();
  await expect(canvas).toHaveCount(0);
  await replaceNumber(page, "直徑（mm）", "41");
  await expect(page.getByLabel("直徑（mm）", { exact: true })).toHaveValue("41");
});

test("iPad viewport has no horizontal overflow, 44 px controls, and keyboard tabs", async ({ page }) => {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  const sizes = await page.locator("button, input:not([type=color]), select").evaluateAll((controls) =>
    controls.map((control) => ({
      label: control.getAttribute("aria-label") ?? control.textContent?.trim(),
      height: control.getBoundingClientRect().height,
    })));
  expect(sizes.filter(({ height }) => height > 0 && height < 44)).toEqual([]);

  const topTab = page.getByRole("tab", { name: "俯視圖" });
  await topTab.focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { name: "分解圖" })).toBeFocused();
  await expect(page.getByRole("img", { name: "陀螺分解圖" })).toBeVisible();
});

test("root route also loads the designer", async ({ page }) => {
  await page.goto(".");
  await expect(page.getByRole("heading", { name: "陀螺設計器" })).toBeVisible();
});
