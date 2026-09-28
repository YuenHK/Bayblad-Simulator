import { expect, test } from "@playwright/test";

const viewports = [
  { name: "phone", width: 390, height: 844 },
  { name: "ipad-portrait", width: 768, height: 1024 },
  { name: "ipad-landscape", width: 1024, height: 768 },
  { name: "desktop", width: 1440, height: 900 },
] as const;

for (const viewport of viewports) {
  test(`${viewport.name} keeps the student UI within the viewport`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("designer");
    await expect(page.getByRole("heading", { name: "陀螺設計器" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    const undersized = await page.locator("button:visible,input:visible:not([type=color]),select:visible").evaluateAll((controls) => controls
      .map((control) => ({ label: control.getAttribute("aria-label") ?? control.textContent?.trim(), height: control.getBoundingClientRect().height }))
      .filter(({ height }) => height < 44));
    expect(undersized).toEqual([]);
  });
}

test("phone switches between shape, preview and assembly tabs without losing inputs", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("designer");
  const tabs = page.getByRole("tablist", { name: "設計室區域" });
  await expect(tabs).toBeVisible();
  await page.getByRole("spinbutton", { name: "直徑（mm）", exact: true }).fill("58");
  await page.getByRole("tab", { name: "預覽", exact: true }).click();
  await expect(page.getByRole("heading", { name: "即時預覽" })).toBeVisible();
  await expect(page.getByRole("heading", { name: /層板設計/ })).toBeHidden();
  await page.getByRole("tab", { name: "裝配", exact: true }).click();
  await expect(page.getByRole("heading", { name: "即時計算" })).toBeVisible();
  await page.getByRole("tab", { name: "造型", exact: true }).click();
  await expect(page.getByRole("spinbutton", { name: "直徑（mm）", exact: true })).toHaveValue("58");
});

test("tablet and desktop display every design region without mobile tabs", async ({ page }) => {
  for (const viewport of [{ width: 1024, height: 768 }, { width: 1440, height: 900 }]) {
    await page.setViewportSize(viewport);
    await page.goto("designer");
    await expect(page.getByRole("tablist", { name: "設計室區域" })).toBeHidden();
    await expect(page.getByRole("heading", { name: /層板設計/ })).toBeVisible();
    await expect(page.getByRole("heading", { name: "即時預覽" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "即時計算" })).toBeVisible();
  }
});
