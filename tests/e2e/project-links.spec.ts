import { expect, test } from "@playwright/test";

test("project links are readable on desktop and mobile and open separately", async ({ page }, testInfo) => {
  await page.goto(".");
  const footer = page.getByRole("contentinfo", { name: "專案與更多作品" });
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await footer.scrollIntoViewIfNeeded({ timeout: 10_000 });
    await expect(footer).toBeVisible();
    for (const [name, href] of [
      ["專案介紹・GitHub", "https://github.com/YuenHK/Bayblad-Simulator#readme"],
      ["探索 ShapeCut", "https://yuenhk.github.io/ShapeCut/"],
    ] as const) {
      const link = footer.getByRole("link", { name, exact: true });
      await expect(link).toHaveAttribute("href", href!);
      await expect(link).toHaveAttribute("target", "_blank");
      await expect(link).toHaveAttribute("rel", "noopener noreferrer");
      await expect(link).toBeInViewport();
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await footer.screenshot({ path: testInfo.outputPath(`project-links-${width}.png`) });
  }
});
