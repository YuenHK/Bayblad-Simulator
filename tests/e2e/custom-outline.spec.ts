import { expect, test } from "@playwright/test";

for (const width of [1440, 390]) {
  test(`custom outline can be drawn and applied at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(".");
    await page.getByRole("button", { name: "自定造型", exact: true }).click();
    const canvas = page.getByLabel("自定輪廓畫布", { exact: true });
    await canvas.scrollIntoViewIfNeeded();
    const box = (await canvas.boundingBox())!;
    const points = [[-18, -18], [18, -18], [18, 18], [-18, 18], [-18, -18]].map(([x, y]) => ({ x: box.x + (x! + 44) / 88 * box.width, y: box.y + (44 - y!) / 88 * box.height }));
    if (width === 390) {
      const touch = await page.context().newCDPSession(page);
      await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [points[0]!] });
      for (const point of points.slice(1)) await touch.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [point] });
      await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await touch.detach();
    } else {
      await page.mouse.move(points[0]!.x, points[0]!.y);
      await page.mouse.down();
      for (const point of points.slice(1)) await page.mouse.move(point.x, point.y, { steps: 6 });
      await page.mouse.up();
    }
    const apply = page.getByRole("button", { name: "套用自定造型", exact: true });
    await expect(apply).toBeEnabled();
    await apply.click();
    await expect(page.locator(".layer-list")).toContainText("自定造型");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`custom-${width}.png`), fullPage: true });
  });
}
