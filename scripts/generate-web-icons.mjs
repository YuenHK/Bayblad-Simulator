// Rebuild raster fallbacks from the repository's vector source; no external assets.
// Run from the repository root after installing the existing Playwright Chromium.
import { readFile, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';

const root = new URL('../apps/web/public/icons/', import.meta.url);
const svg = await readFile(new URL('favicon.svg', root), 'utf8');
const browser = await chromium.launch();
try {
  for (const [name, size] of [['favicon-32.png',32], ['apple-touch-icon.png',180], ['icon-192.png',192], ['icon-512.png',512]]) {
    const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
    await page.setContent(`<html><head><style>html,body{margin:0;width:100%;height:100%;background:#09142d}svg{display:block;width:100%;height:100%}</style></head><body>${svg}</body></html>`);
    await page.screenshot({ path: new URL(name, root).pathname, type: 'png' });
    await page.close();
  }
} finally { await browser.close(); }
const png = await readFile(new URL('favicon-32.png', root));
const ico = Buffer.alloc(22);
ico.writeUInt16LE(1, 2); // ICO image type
ico.writeUInt16LE(1, 4); // one image
ico[6] = 32; ico[7] = 32;
ico.writeUInt16LE(1, 10); ico.writeUInt16LE(32, 12);
ico.writeUInt32LE(png.length, 14); ico.writeUInt32LE(22, 18);
await writeFile(new URL('favicon.ico', root), Buffer.concat([ico, png]));
console.log('Generated four PNG sizes and ICO from favicon.svg');
