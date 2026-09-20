import { expect, test } from '@playwright/test';

for (const width of [1280, 390]) test(`real STL transfers to ShapeCut material selection at ${width}px`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height: 980 });
  await page.goto('.');
  if (width < 1000) await page.getByRole('tab', { name: '預測結果', exact: true }).click();
  const buttons = page.locator('.design-action-row > button');
  const bounds = await buttons.evaluateAll(nodes => nodes.map(n => ({ height: n.getBoundingClientRect().height, x: n.getBoundingClientRect().x })));
  expect(bounds).toHaveLength(3);
  expect(new Set(bounds.map(b => b.height)).size).toBe(1);
  if (width === 390) expect(new Set(bounds.map(b => b.x)).size).toBe(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('designer-actions.png'), fullPage: true });
  const popupPromise = page.waitForEvent('popup');
  await page.getByRole('button', { name: '傳送至 ShapeCut', exact: true }).click();
  const receiver = await popupPromise;
  await expect(receiver.getByRole('button', { name: '開始製作', exact: true })).toBeVisible({ timeout: 60_000 });
  await expect(receiver.getByText('bayblad-3layers-6mm-mm.stl', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'ShapeCut 已接收板材' })).toBeVisible();
  await receiver.screenshot({ path: testInfo.outputPath('shapecut-material.png'), fullPage: true });
  // No automatic conversion or download: the user retains control over fabrication.
  await expect(receiver.getByRole('button', { name: '開始製作', exact: true })).toBeEnabled();
  await receiver.close();
});
