import { expect, test } from "@playwright/test";

for (const [width, height] of [[1440, 900], [1024, 768]]) {
  test(`designer tools stay reachable ${width}x${height}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: width!, height: height! });
    await page.goto(".");
    await expect(page.getByText("已連線", { exact: true })).toBeVisible({ timeout: 60000 });
    await page.getByRole("tab", { name: "共用裝配", exact: true }).click();
    await expect(page.getByRole("combobox", { name: "金屬碟直徑", exact: true })).toBeInViewport({ ratio: 1, timeout: 10000 });
    await page.getByRole("tab", { name: "層板造型", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "顏色", exact: true })).toBeInViewport({ ratio: 1 });
    await page.getByRole("button", { name: "用此設計參戰", exact: true }).scrollIntoViewIfNeeded();
    await expect(page.getByRole("button", { name: "用此設計參戰", exact: true })).toBeInViewport({ ratio: 1 });
    // Leave room for platform-specific system-font metrics (Linux/iPad/macOS).
    const actionBounds = await page.getByRole("button", { name: "用此設計參戰", exact: true }).boundingBox();
    expect(actionBounds!.y + actionBounds!.height).toBeLessThanOrEqual(height! - 12);
    await page.getByRole("button", { name: "編輯中層" }).click();
    await expect(page.getByRole("spinbutton", { name: "直徑（mm）", exact: true })).toHaveValue("55");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`designer-${width}.png`) });
  });
}
