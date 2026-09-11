import { expect, test } from "@playwright/test";

for (const [width, height] of [[1440, 900], [1024, 768]]) {
  test(`designer parameters fit ${width}x${height}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: width!, height: height! });
    await page.goto(".");
    await expect(page.getByText("已連線", { exact: true })).toBeVisible({ timeout: 60000 });
    await expect(page.getByRole("combobox", { name: "金屬碟直徑", exact: true })).toBeInViewport({ ratio: 1, timeout: 10000 });
    await expect(page.getByLabel("顏色", { exact: true })).toBeInViewport({ ratio: 1 });
    await expect(page.getByRole("button", { name: "用此設計參戰", exact: true })).toBeInViewport({ ratio: 1 });
    await page.getByRole("combobox", { name: "目前編輯層", exact: true }).selectOption("middle");
    await expect(page.getByLabel("直徑（mm）", { exact: true })).toHaveValue("55");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`designer-${width}.png`) });
  });
}
