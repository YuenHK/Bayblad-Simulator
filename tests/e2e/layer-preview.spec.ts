import { expect, test } from "@playwright/test";

for (const width of [390, 1024, 1440]) {
  test(`selected board preserves scale and holes at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("designer");
    await expect(page.getByRole("button", { name: "實驗室", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "開始教學", exact: true })).toHaveCount(0);
    if (width < 900) await page.getByRole("tab", { name: "預覽", exact: true }).click();
    const boxes: string[] = [];
    for (const label of ["頂層", "中層", "底層"]) {
      await page.getByRole("button", { name: `編輯${label}`, exact: true }).click();
      if (width < 900) await page.getByRole("tab", { name: "預覽", exact: true }).click();
      const view = page.getByRole("img", { name: `${label}俯視圖` });
      for (const other of ["頂層", "中層", "底層"].filter(x => x !== label)) await expect(page.getByRole("img", { name: `${other}俯視圖` })).toHaveCount(0);
      await expect(view).toBeVisible();
      await expect(view.getByTestId("layer-path")).toHaveCount(1);
      await expect(view.getByTestId("screw-hole")).toHaveCount(4);
      boxes.push((await view.getAttribute("viewBox"))!);
    }
    expect(new Set(boxes).size).toBe(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

test("3D starts at 180 degrees on X, visibly spins, pauses and retains zoom gestures", async ({ page }) => {
  await page.goto("designer");
  await page.getByRole("tab", { name: "3D 預覽", exact: true }).click();
  const preview = page.getByTestId("top-preview-3d");
  await expect(preview).toHaveAttribute("data-preview-rotation", `${Math.PI},0`);
  const canvas = preview.locator("canvas");
  await expect(canvas).toBeVisible();
  await page.waitForTimeout(400);
  // Freeze only CSS scanlines; the Three.js render-loop motion remains active.
  const spinning = await canvas.screenshot({ animations: "disabled" });
  await page.waitForTimeout(600);
  expect((await canvas.screenshot({ animations: "disabled" })).equals(spinning)).toBe(false);
  await page.getByRole("button", { name: "暫停自轉", exact: true }).click();
  await page.waitForTimeout(150);
  const paused = await canvas.screenshot({ animations: "disabled" });
  await page.waitForTimeout(600);
  expect((await canvas.screenshot({ animations: "disabled" })).equals(paused)).toBe(true);
  const rotation = await preview.getAttribute("data-preview-rotation");
  await preview.press("ArrowRight");
  await expect(preview).not.toHaveAttribute("data-preview-rotation", rotation!);
  await preview.press("+");
  await expect(preview).not.toHaveAttribute("data-preview-zoom", "1");
});

test("desktop actions stay together at equal height and enlarged boards fit", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("designer");
  const labels = ["用此設計參戰", "傳送至 ShapeCut（供 雷射切割)", "下載 STL（供 3D打印)"];
  const rects = [];
  for (const name of labels) rects.push(await page.getByRole("button", { name, exact: true }).boundingBox());
  for (const rect of rects) expect(rect).not.toBeNull();
  expect(new Set(rects.map(r => r!.y)).size).toBe(1);
  expect(new Set(rects.map(r => r!.height)).size).toBe(1);
  for (let i = 1; i < rects.length; i++) expect(rects[i]!.x - rects[i - 1]!.x - rects[i - 1]!.width).toBeCloseTo(10, 0);
  await page.getByRole("tab", { name: "分解圖", exact: true }).click();
  const graphic = page.getByRole("img", { name: "陀螺分解圖", exact: true });
  for (const layer of await graphic.getByTestId("exploded-layer").all()) await expect(layer).toHaveAttribute("transform", /scale\(2\.16 1\.02\)/);
  const fits = await graphic.evaluate(svg => {
    const outer = svg.getBoundingClientRect();
    return [...svg.querySelectorAll('[data-testid="exploded-layer"]')].every(g => {
      const r = g.getBoundingClientRect();
      return r.left >= outer.left && r.right <= outer.right && r.top >= outer.top && r.bottom <= outer.bottom;
    });
  });
  expect(fits).toBe(true);
});
