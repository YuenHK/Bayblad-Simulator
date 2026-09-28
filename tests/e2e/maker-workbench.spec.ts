import { expect, test } from "@playwright/test";

for (const [width, height] of [[1440,900], [1280,720], [1024,768], [768,1024], [390,844], [320,568]]) {
  test(`workbench stays usable at ${width}x${height}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: width!, height: height! });
    await page.goto(".");
    await expect(page.getByRole("button", { name: "編輯頂層" })).toBeVisible();
    await page.getByRole("spinbutton", { name: "直徑（mm）", exact: true }).fill("81");
    await page.getByRole("button", { name: "編輯中層" }).click();
    await expect(page.getByRole("button", { name: "規格未通過，請先修正" })).toBeDisabled();
    await page.getByRole("button", { name: "前往頂層修正" }).click();
    await expect(page.getByRole("spinbutton", { name: "直徑（mm）", exact: true })).toHaveValue("81");
    await page.getByRole("spinbutton", { name: "直徑（mm）", exact: true }).fill("40");
    await page.getByRole("button", { name: "將目前層下移" }).click();
    await expect(page.getByRole("button", { name: "編輯中層" })).toHaveAttribute("aria-pressed", "true");
    const assembly = page.getByRole("tab", { name: width! < 900 ? "裝配" : "共用裝配", exact: true });
    await assembly.click();
    await expect(page.getByRole("spinbutton", { name: "螺絲數量" })).toBeVisible();
    await page.getByRole("tab", { name: width! < 900 ? "造型" : "層板造型", exact: true }).click();
    if (width! < 900) {
      await page.getByRole("tab", { name: "預覽", exact: true }).click();
      await expect(page.getByRole("img", { name: "陀螺俯視圖" })).toBeVisible();
      await expect(page.getByRole("spinbutton", { name: "直徑（mm）", exact: true })).toHaveCount(0);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const shortControls = await page.locator("button:visible,input:visible:not([type=color]),select:visible").evaluateAll(nodes => nodes.filter(n => n.getBoundingClientRect().height < 44).map(n => n.getAttribute("aria-label") ?? n.textContent));
    expect(shortControls).toEqual([]);
    const metricsStacked = await page.locator(".metrics > div").evaluateAll(nodes => nodes.every(node => {
      const label = node.querySelector("dt")!.getBoundingClientRect();
      const value = node.querySelector("dd")!.getBoundingClientRect();
      return value.top >= label.bottom;
    }));
    expect(metricsStacked).toBe(true);
    await page.evaluate(() => scrollTo(0,0));
    await page.screenshot({ path: testInfo.outputPath(`workbench-${width}.png`), fullPage: true });
  });
}

test("200% zoom equivalent viewport and reduced motion keep every tool reachable", async ({ page }, testInfo) => {
  // Browser page zoom halves the CSS viewport; CSS zoom alone does not update media queries.
  await page.setViewportSize({ width: 720, height: 450 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(".");
  await page.getByRole("button", { name: "編輯中層" }).click();
  await page.getByRole("button", { name: "將目前層上移" }).click();
  await expect(page.getByRole("button", { name: "編輯頂層" })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("tab", { name: "裝配", exact: true }).click();
  await expect(page.getByRole("spinbutton", { name: "螺絲數量" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("workbench-zoom.png"), fullPage: true });
});
