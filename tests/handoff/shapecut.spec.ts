import { expect, test } from '@playwright/test';
import { stat } from 'node:fs/promises';

for (const [width, custom] of [[1280, false], [390, false], [1280, true]] as const) test(`real ${custom ? 'custom' : 'basic'} STL transfers to ShapeCut material selection at ${width}px`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height: 980 });
  await page.goto('.');
  if (custom) {
    await page.getByRole('button', { name: '自定造型', exact: true }).click();
    const canvas = page.getByLabel('自定輪廓畫布', { exact: true });
    await canvas.scrollIntoViewIfNeeded();
    const box = (await canvas.boundingBox())!, size = Math.min(box.width, box.height);
    const ring = [[-18,-16],[22,-16],[22,8],[12,8],[12,20],[-18,20],[-18,-16]];
    for (let i=0;i<ring.length;i++) {
      const [x,y]=ring[i]!;
      await page.mouse.move(box.x+box.width/2+x!/88*size, box.y+box.height/2-y!/88*size, { steps: i ? 5 : 1 });
      if (!i) await page.mouse.down();
    }
    await page.mouse.up();
    await page.getByRole('button', { name: '套用自定造型', exact: true }).click();
    await expect(page.locator('.layer-list')).toContainText('自定造型');
    await testInfo.attach('custom-design.json', { body: await page.evaluate(() => localStorage.getItem('steam-top:designer-draft:v1') ?? ''), contentType: 'application/json' });
    const downloaded = page.waitForEvent('download');
    await page.getByRole('button', { name: '下載 STL（供 3D打印)', exact: true }).click();
    const stl = await downloaded;
    expect(await stl.failure()).toBeNull();
    expect(stl.suggestedFilename()).toMatch(/\.stl$/u);
    const stlPath = await stl.path();
    expect(stlPath).not.toBeNull();
    expect((await stat(stlPath!)).size).toBeGreaterThan(84);
  }
  if (width < 1000) await page.getByRole('tab', { name: '預測結果', exact: true }).click();
  const buttons = page.locator('.design-action-row > button');
  const bounds = await buttons.evaluateAll(nodes => nodes.map(n => ({ height: n.getBoundingClientRect().height, x: n.getBoundingClientRect().x })));
  expect(bounds).toHaveLength(3);
  expect(new Set(bounds.map(b => b.height)).size).toBe(1);
  if (width === 390) expect(new Set(bounds.map(b => b.x)).size).toBe(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('designer-actions.png'), fullPage: true });
  const popupPromise = page.waitForEvent('popup');
  await page.getByRole('button', { name: '傳送至 ShapeCut（供 雷射切割)', exact: true }).click();
  const receiver = await popupPromise;
  await expect(receiver.getByRole('button', { name: '開始製作', exact: true })).toBeVisible({ timeout: 60_000 });
  await expect(receiver.getByText('bayblad-3layers-6mm-mm.stl', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'ShapeCut 已接收板材' })).toBeVisible();
  await receiver.screenshot({ path: testInfo.outputPath('shapecut-material.png'), fullPage: true });
  // No automatic conversion or download: the user retains control over fabrication.
  await expect(receiver.getByRole('button', { name: '開始製作', exact: true })).toBeEnabled();
  if (custom) {
    const material = receiver.getByRole('combobox', { name: '選擇製作材料' });
    const sixMm = await material.locator('option').filter({ hasText: '(6 mm)' }).first().getAttribute('value');
    expect(sixMm).toBeTruthy();
    await material.selectOption(sixMm!);
    await receiver.getByRole('button', { name: '開始製作', exact: true }).click();
    await expect(receiver.getByRole('heading', { name: '轉換完成', exact: true })).toBeVisible({ timeout: 60_000 });
    await expect(receiver.getByRole('link', { name: '下載 ZIP 製作套件', exact: true })).toHaveAttribute('href', /^blob:/);
    await expect(receiver.getByRole('combobox', { name: '選擇預覽切片' }).locator('option')).toHaveCount(3);
    await receiver.screenshot({ path: testInfo.outputPath('custom-shapecut-result.png'), fullPage: true });
  }
  await receiver.close();
});
