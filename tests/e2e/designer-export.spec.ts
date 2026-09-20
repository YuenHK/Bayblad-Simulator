import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';

test('downloads three-board STL lazily with exact thickness on desktop and narrow screens', async ({ page }, testInfo) => {
  const wasmRequests: string[] = [];
  page.on('request', request => { if (/manifold.*\.wasm/.test(request.url())) wasmRequests.push(request.url()); });
  await page.goto('.');
  await expect(page.getByRole('heading', { name: '陀螺設計器' })).toBeVisible();
  expect(wasmRequests).toHaveLength(0);
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: '下載 STL（供 ShapeCut）' }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe('bayblad-3layers-6mm-mm.stl');
  const output = testInfo.outputPath(download.suggestedFilename());
  await download.saveAs(output);
  const bytes = await readFile(output);
  const count = bytes.readUInt32LE(80);
  expect(bytes.length).toBe(84 + count * 50);
  let minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < count; i++) for (let corner=0; corner<3; corner++) {
    const z = bytes.readFloatLE(84 + i*50 + 12 + corner*12 + 8);
    minZ = Math.min(minZ,z); maxZ = Math.max(maxZ,z);
  }
  expect([minZ,maxZ]).toEqual([0,18]);
  expect(wasmRequests.length).toBeGreaterThan(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('tab', { name: '模擬預覽', exact: true }).click();
  await expect(page.getByRole('button', { name: '下載 STL（供 ShapeCut）' })).toBeVisible();
  const secondDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: '下載 STL（供 ShapeCut）' }).click();
  const narrowDownload = await secondDownload;
  const narrowOutput = testInfo.outputPath('narrow-screen.stl');
  await narrowDownload.saveAs(narrowOutput);
  expect(await readFile(narrowOutput)).toEqual(bytes);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
