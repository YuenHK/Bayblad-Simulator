import { expect, test } from "@playwright/test";

for (const width of [390, 1024, 1440]) {
  test(`separate board views preserve scale and holes at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("designer");
    await expect(page.getByRole("button", { name: "實驗室", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "開始教學", exact: true })).toHaveCount(0);
    if (width < 900) await page.getByRole("tab", { name: "預覽", exact: true }).click();
    const views = ["頂層", "中層", "底層"].map(label => page.getByRole("img", { name: `${label}俯視圖` }));
    const boxes: string[] = [];
    for (const view of views) {
      await expect(view).toBeVisible();
      await expect(view.getByTestId("layer-path")).toHaveCount(1);
      await expect(view.getByTestId("screw-hole")).toHaveCount(4);
      boxes.push((await view.getAttribute("viewBox"))!);
    }
    expect(new Set(boxes).size).toBe(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

test("3D starts tilted 90 degrees on X, visibly spins, pauses and retains zoom gestures", async ({ page }) => {
  await page.goto("designer");
  await page.getByRole("tab", { name: "3D 預覽", exact: true }).click();
  const preview = page.getByTestId("top-preview-3d");
  await expect(preview).toHaveAttribute("data-preview-rotation", `${Math.PI / 2},0`);
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
