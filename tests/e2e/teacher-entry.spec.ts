import { expect, test } from "@playwright/test";

for (const width of [1440, 390]) {
  test(`主頁教師入口與作品連結並列 ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(".");
    const footer = page.getByRole("contentinfo", { name: "專案與更多作品" });
    await footer.scrollIntoViewIfNeeded();
    await expect(footer.getByRole("heading", { name: "了解這個專案" })).toBeVisible();
    await expect(footer.getByRole("heading", { name: "我的另一個作品・ShapeCut" })).toBeVisible();
    const link = footer.getByRole("link", { name: "進入教師後台" });
    await expect(link).toHaveAttribute("href", "https://bayblad-simulator-api.onrender.com/admin/");
    await expect(link).toHaveAttribute("target", "_blank");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await footer.screenshot({ path: testInfo.outputPath(`footer-${width}.png`) });
  });
}
